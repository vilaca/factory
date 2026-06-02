import Anthropic from '@anthropic-ai/sdk';
import type {
  Provider,
  ChatMessage,
  ChatChunk,
  TokenUsage,
  ToolDefinition,
  ToolCallMessage,
  ProviderCapabilities,
  ModelPickerInfo,
  ChatOptions,
} from './types.js';
import {
  formatTokenCount,
  parseToolArgs,
  resolveSampling,
  type ResolvedSampling,
} from './shared.js';
import { appendProviderLog } from '../utils/provider-log.js';

/** Build the Anthropic-only subset of sampling + tool_choice extras for
 *  a single call. Anthropic accepts `temperature`, `top_p`, `top_k`,
 *  and a `tool_choice` object; min_p / repeat_penalty / presence_penalty
 *  are silently dropped. Pulled out so the streaming + non-streaming
 *  params builders stay under the per-method complexity cap. */
function anthropicExtras(
  sampling: ResolvedSampling,
  forceToolCall: boolean,
  hasTools: boolean,
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  if (sampling.temperature !== undefined) extras.temperature = sampling.temperature;
  if (sampling.top_p !== undefined) extras.top_p = sampling.top_p;
  if (sampling.top_k !== undefined) extras.top_k = sampling.top_k;
  if (forceToolCall && hasTools) extras.tool_choice = { type: 'any' as const };
  return extras;
}

type StreamingParams = Anthropic.Messages.MessageCreateParamsStreaming;
type NonStreamingParams = Anthropic.Messages.MessageCreateParamsNonStreaming;
type MessageParam = Anthropic.Messages.MessageParam;
type ToolUnion = Anthropic.Messages.ToolUnion;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;
type AnthropicStreamEvent = Anthropic.Messages.RawMessageStreamEvent;

interface AnthropicStreamToolCall {
  id: string;
  name: string;
  rawArgs: string;
}

interface AnthropicStreamState {
  currentToolCall: AnthropicStreamToolCall | null;
  usageSnapshot: AnthropicUsageLike | undefined;
  sawTerminalChunk: boolean;
}

function makeTerminalChunk(state: AnthropicStreamState, doneReason?: string): ChatChunk {
  return {
    done: true,
    ...(state.usageSnapshot ? { usage: mapAnthropicUsage(state.usageSnapshot) } : {}),
    ...(doneReason ? { doneReason } : {}),
  };
}

function handleAnthropicStreamEvent(
  event: AnthropicStreamEvent,
  state: AnthropicStreamState,
): ChatChunk[] {
  switch (event.type) {
    case 'message_start':
      state.usageSnapshot = mergeAnthropicUsage(state.usageSnapshot, event.message.usage);
      return [];

    case 'content_block_start':
      if (event.content_block.type === 'tool_use') {
        state.currentToolCall = {
          id: event.content_block.id,
          name: event.content_block.name,
          rawArgs: '',
        };
      }
      return [];

    case 'content_block_delta':
      if (event.delta.type === 'text_delta') {
        return [{ content: event.delta.text }];
      }
      if (event.delta.type === 'input_json_delta' && state.currentToolCall) {
        state.currentToolCall.rawArgs += event.delta.partial_json;
      }
      return [];

    case 'content_block_stop': {
      if (!state.currentToolCall) return [];
      const args = parseToolArgs(state.currentToolCall.rawArgs);
      const toolChunk: ChatChunk = {
        tool_calls: [
          {
            id: state.currentToolCall.id,
            function: { name: state.currentToolCall.name, arguments: args },
          },
        ],
      };
      state.currentToolCall = null;
      return [toolChunk];
    }

    case 'message_delta': {
      state.usageSnapshot = mergeAnthropicUsage(state.usageSnapshot, event.usage);
      const doneReason = mapAnthropicStopReason(event.delta?.stop_reason);
      state.sawTerminalChunk = true;
      return [makeTerminalChunk(state, doneReason)];
    }

    case 'message_stop':
      if (state.sawTerminalChunk) return [];
      return [makeTerminalChunk(state)];

    default:
      return [];
  }
}

/** Suffix appended to a model ID to indicate the user wants the 200k
 *  context cap rather than the full 1M window. The real model ID is
 *  obtained by stripping this suffix before any API call or cache
 *  lookup; `requestOptionsFor` skips the beta header when it is present. */
const CTX_200K_SUFFIX = '+200k';
const CTX_200K_LIMIT = 200_000;

function stripCtxSuffix(model: string): string {
  return model.endsWith(CTX_200K_SUFFIX) ? model.slice(0, -CTX_200K_SUFFIX.length) : model;
}

function hasCappedCtx(model: string): boolean {
  return model.endsWith(CTX_200K_SUFFIX);
}

export class AnthropicProvider implements Provider {
  name = 'anthropic';
  private client: Anthropic;
  /** Per-model metadata captured during listModels(). The SDK's
   *  models.list endpoint returns max_input_tokens / max_tokens for every
   *  model id, so we use that as the source of truth for context window
   *  and output cap instead of hardcoding per-family numbers (which
   *  miss things like Opus 4.x's 1M-token context). The map stays empty
   *  until listModels() runs; getCapabilities() throws on a cache miss
   *  rather than inventing defaults, so any code path that resolves a
   *  model without going through the picker / startup listing surfaces
   *  loudly instead of silently using wrong numbers. Startup
   *  (cli/startup/phases.ts) and probeModels (cli/auth/index.ts) both
   *  call listModels() before any capability read, which is what keeps
   *  the cache warm in practice. */
  private modelInfoCache = new Map<string, Anthropic.Models.ModelInfo>();

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        'Anthropic API key required. Set ANTHROPIC_API_KEY env var or use --token flag.',
      );
    }
    this.client = new Anthropic({ apiKey: key });
  }

  async listModels(): Promise<string[]> {
    const models: string[] = [];
    for await (const model of this.client.models.list({ limit: 1000 })) {
      models.push(model.id);
      this.modelInfoCache.set(model.id, model);
      // Emit a capped-context variant for models that support >200k so the
      // picker shows both options and the user can pick the cheaper/faster one.
      if (typeof model.max_input_tokens === 'number' && model.max_input_tokens > CTX_200K_LIMIT) {
        models.push(model.id + CTX_200K_SUFFIX);
      }
    }
    return models;
  }

  getModelPickerInfo(model: string): ModelPickerInfo {
    const capped = hasCappedCtx(model);
    const realId = stripCtxSuffix(model);
    const lower = realId.toLowerCase();
    const caps = this.getCapabilities(model);
    const info = this.modelInfoCache.get(realId);
    return {
      label: capped ? `${realId} (200k)` : realId,
      detail: buildModelDetail(caps, info?.capabilities ?? null),
      warning: buildModelWarning(lower),
    };
  }

  getCapabilities(model: string): ProviderCapabilities {
    const capped = hasCappedCtx(model);
    const realId = stripCtxSuffix(model);
    const info = this.modelInfoCache.get(realId);
    if (!info) {
      throw new Error(
        `Anthropic model ${realId} has no cached ModelInfo — listModels() must run before getCapabilities(). ` +
          `This indicates a code-path that resolves a model without going through the picker / startup listing.`,
      );
    }
    if (typeof info.max_input_tokens !== 'number' || typeof info.max_tokens !== 'number') {
      throw new Error(
        `Anthropic model ${realId} is missing max_input_tokens / max_tokens in the SDK response — ` +
          `cannot derive capabilities without inventing numbers.`,
      );
    }
    return {
      contextWindow: capped ? CTX_200K_LIMIT : info.max_input_tokens,
      maxOutputTokens: info.max_tokens,
      toolSupport: 'native',
      parallelToolCalls: true,
      streaming: true,
      tokenCounting: 'exact',
      // Tier isn't on Anthropic's ModelInfo; derived from the id as a UX hint
      // for system-prompt selection and weak-tier routing. Not a hard fact —
      // see the cross-provider capabilities reshape follow-up.
      modelTier: anthropicTierFromId(realId.toLowerCase()),
    };
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const { system, msgs } = this.splitMessages(messages);
    const apiModel = stripCtxSuffix(model);

    const hasTools = !!tools && tools.length > 0;
    const sampling = resolveSampling(options, { model: apiModel, providerName: 'anthropic' });
    const extras = anthropicExtras(sampling, options?.forceToolCall ?? false, hasTools);
    const params: StreamingParams = {
      model: apiModel,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens(model),
      messages: msgs,
      stream: true,
      ...(system !== null ? { system } : {}),
      ...(hasTools ? { tools: buildAnthropicTools(tools!, options?.cacheTools) } : {}),
      ...extras,
    };

    const stream = this.client.messages.stream(params, this.requestOptionsFor(model));
    const state: AnthropicStreamState = {
      currentToolCall: null,
      usageSnapshot: undefined,
      sawTerminalChunk: false,
    };

    for await (const event of stream) {
      const chunks = handleAnthropicStreamEvent(event, state);
      for (const chunk of chunks) {
        yield chunk;
      }
    }
  }

  async chatNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk> {
    const { system, msgs } = this.splitMessages(messages);
    const apiModel = stripCtxSuffix(model);

    const hasTools = !!tools && tools.length > 0;
    const sampling = resolveSampling(options, { model: apiModel, providerName: 'anthropic' });
    const extras = anthropicExtras(sampling, options?.forceToolCall ?? false, hasTools);
    const params: NonStreamingParams = {
      model: apiModel,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens(model),
      messages: msgs,
      ...(system !== null ? { system } : {}),
      ...(hasTools ? { tools: buildAnthropicTools(tools!, options?.cacheTools) } : {}),
      ...extras,
    };

    const response = await this.client.messages.create(params, this.requestOptionsFor(model));

    let content = '';
    const toolCalls: ToolCallMessage[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          function: {
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          },
        });
      }
    }

    const usage = mapAnthropicUsage(response.usage);
    const doneReason = mapAnthropicStopReason(response.stop_reason);
    return {
      content: content || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      done: true,
      ...(doneReason ? { doneReason } : {}),
      usage,
    };
  }

  private splitMessages(messages: ChatMessage[]): {
    system: StreamingParams['system'] | null;
    msgs: MessageParam[];
  } {
    return splitMessagesForAnthropic(messages);
  }

  /** Default output cap for Anthropic calls when the caller does not set
   *  `options.maxTokens`.
   *
   *  Prefer the model's advertised `max_tokens` from Models API metadata so we
   *  don't under-cap newer models (e.g. Opus/Sonnet variants) with a static
   *  constant. Keep an 8192 fallback for cache-cold paths.
   *
   *  TODO(config): make this user-configurable (global/provider/model-level)
   *  so users can trade off latency/cost vs verbosity without patching code. */
  private defaultMaxTokens(model: string): number {
    return this.modelInfoCache.get(stripCtxSuffix(model))?.max_tokens ?? 8192;
  }

  /** Per-request options layered on top of the SDK client defaults.
   *  Opts into Anthropic's `context-1m-2025-08-07` beta when the cached
   *  ModelInfo for this id advertises an input window larger than 200k
   *  tokens — without the header the API silently caps at 200k
   *  regardless of what the model "supports". Returns undefined
   *  (= no extra options) otherwise so the common path stays a plain
   *  default-headers request.
   *
   *  Skips the beta header when the caller selected the +200k capped
   *  variant (CTX_200K_SUFFIX), which is the cheaper/faster option.
   *
   *  Reads from the same modelInfoCache the picker uses, so what the
   *  picker shows ("1M ctx") and what the request actually sends (1M
   *  beta header) come from the same source — the SDK. If the cache is
   *  cold the user couldn't have selected the model through the picker
   *  in the first place, so undefined here is the right behavior. */
  private requestOptionsFor(model: string): { headers: Record<string, string> } | undefined {
    if (hasCappedCtx(model)) return undefined;
    const info = this.modelInfoCache.get(model);
    if (!info?.max_input_tokens || info.max_input_tokens <= CTX_200K_LIMIT) return undefined;
    return { headers: { 'anthropic-beta': 'context-1m-2025-08-07' } };
  }
}

/** Anthropic accepts the `tools` array as either:
 *  - `[{ name, description, input_schema }, ...]` (no caching), or
 *  - `[..., { name, description, input_schema, cache_control: { type: 'ephemeral' } }]`
 *    where the cache_control on the LAST tool entry marks "cache up to and
 *    including all tool definitions". Default 5-min TTL. */
export function buildAnthropicTools(tools: ToolDefinition[], cacheLast?: boolean): ToolUnion[] {
  const out: ToolUnion[] = tools.map(t => ({
    name: t.function.name,
    description: t.function.description ?? '',
    input_schema: t.function.parameters as Anthropic.Messages.Tool.InputSchema,
  }));
  if (cacheLast && out.length > 0) {
    out[out.length - 1] = {
      ...out[out.length - 1]!,
      cache_control: { type: 'ephemeral' },
    } as ToolUnion;
  }
  return out;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(complexity): split system/cache/role-walk extraction.
export function splitMessagesForAnthropic(messages: ChatMessage[]): {
  system: StreamingParams['system'] | null;
  msgs: MessageParam[];
} {
  let systemContent: string | null = null;
  let systemCacheBoundary = false;
  const msgs: MessageParam[] = [];
  // Reliability stack (Phase 13): Anthropic rejects messages where
  // any `tool_use` block from a preceding assistant turn doesn't have
  // a matching `tool_result` before the next user message. This
  // happens naturally when the framework emits a step or prereq
  // nudge (`docs/reliability/next-steps.md` §16): the assistant produced a `tool_use`
  // that the framework refused to execute, then injected a corrective
  // user message. We thread a `pendingToolUseIds` set through the
  // walk and synthesize an `is_error: true` `tool_result` block for
  // any leftover IDs at the next user-message boundary.
  const pendingToolUseIds: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemContent = msg.content;
      if (msg.cacheBoundary) systemCacheBoundary = true;
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      const content: ContentBlockParam[] = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      const ids: string[] = [];
      for (const tc of msg.tool_calls) {
        const id = tc.id ?? `toolu_${Math.random().toString(36).slice(2, 14)}`;
        content.push({
          type: 'tool_use',
          id,
          name: tc.function.name,
          input: tc.function.arguments,
        });
        ids.push(id);
      }
      if (msg.cacheBoundary && content.length > 0) {
        content[content.length - 1] = {
          ...content[content.length - 1]!,
          cache_control: { type: 'ephemeral' },
        } as ContentBlockParam;
      }
      msgs.push({ role: 'assistant', content });
      pendingToolUseIds.push(...ids);
    } else if (msg.role === 'tool') {
      // Bare 'unknown' used to be a silent fallback here, which let upstream
      // bugs (corrector running a substitute call without forwarding the
      // original tool_use id) reach the API and 400 with an opaque
      // "unexpected tool_use_id ... unknown". Fail loudly at the boundary
      // instead — every tool_result must carry the id of the tool_use it's
      // resolving.
      if (!msg.tool_call_id) {
        throw new Error(
          'splitMessagesForAnthropic: tool message has no tool_call_id; ' +
            'every tool_result must reference a tool_use from the prior assistant message',
        );
      }
      const block: ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: msg.content,
        ...(msg.cacheBoundary ? { cache_control: { type: 'ephemeral' } } : {}),
      };
      // Anthropic requires all tool_results from one turn to share a single
      // user message that immediately follows the assistant's tool_use
      // blocks. Coalesce consecutive tool messages into one user message.
      const last = msgs[msgs.length - 1];
      if (
        last?.role === 'user' &&
        Array.isArray(last.content) &&
        last.content.every(b => b?.type === 'tool_result')
      ) {
        last.content.push(block);
      } else {
        msgs.push({ role: 'user', content: [block] });
      }
      // Mark this tool_use as resolved. If the id doesn't match any
      // pending tool_use, the API will 400 with "unexpected tool_use_id";
      // log a diagnostic breadcrumb so the orphan is traceable at the
      // boundary rather than only via the opaque upstream rejection.
      const idx = pendingToolUseIds.indexOf(msg.tool_call_id);
      if (idx >= 0) {
        pendingToolUseIds.splice(idx, 1);
      } else {
        appendProviderLog({
          provider: 'anthropic',
          category: 'diagnostic',
          action: 'tool-result-orphan',
          outcome: 'error',
          detail: `tool_call_id=${msg.tool_call_id} did not match any pending tool_use`,
        });
      }
    } else {
      // Plain user / plain assistant text. Before pushing this
      // message, flush any pending tool_use IDs as synthetic
      // is_error blocks — Anthropic rejects unpaired tool_use, and
      // the framework's step/prereq nudge path produces exactly
      // that shape (assistant proposed a call we refused to run).
      // The conversation grammar today only emits nudges as user
      // messages, but flushing on assistant boundaries too is a
      // defensive guard against future regressions that could
      // produce assistant-after-assistant runs (e.g. summary
      // injection, mid-turn rewrites).
      if (pendingToolUseIds.length > 0) {
        const errBlocks: ToolResultBlockParam[] = pendingToolUseIds.map(id => ({
          type: 'tool_result',
          tool_use_id: id,
          content: 'Not executed.',
          is_error: true,
        }));
        msgs.push({ role: 'user', content: errBlocks });
        pendingToolUseIds.length = 0;
      }
      // Plain user / plain assistant text. Convert to block array form when
      // we need to attach cache_control; pass through as a string otherwise
      // so existing snapshots / wire formats stay unchanged.
      if (msg.cacheBoundary) {
        msgs.push({
          role: msg.role,
          content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }],
        });
      } else {
        msgs.push({ role: msg.role, content: msg.content });
      }
    }
  }

  let system: StreamingParams['system'] | null;
  if (systemContent === null) {
    system = null;
  } else if (systemCacheBoundary) {
    system = [{ type: 'text', text: systemContent, cache_control: { type: 'ephemeral' } }];
  } else {
    system = systemContent;
  }

  return { system, msgs };
}

// ─── Picker / capability helpers ───────────────────────────────────────

/** Tier classification derived from the model id. The Models API doesn't
 *  expose a tier/size signal, so this is a name-based UX hint used by
 *  weak-tier routing and system-prompt selection — not a hard
 *  capability. The cross-provider capabilities reshape (see follow-up)
 *  will likely promote this into an explicit, source-tagged field. */
function anthropicTierFromId(lowerModelId: string): ProviderCapabilities['modelTier'] {
  if (lowerModelId.includes('haiku')) return 'medium';
  // opus, sonnet, and anything else default to strong.
  return 'strong';
}

/** Build the picker's "detail" line for an Anthropic model.
 *
 *  Modality / feature badges come from the SDK's `ModelInfo.capabilities`
 *  object, not from id-substring guessing. Older API responses (and any
 *  non-chat model variants) leave `capabilities` null — in that case we
 *  emit only the cost + context/output badges and skip the feature flags
 *  rather than asserting things we don't know. */
function buildModelDetail(
  caps: ProviderCapabilities,
  modelCaps: Anthropic.Models.ModelCapabilities | null,
): string {
  const details: string[] = ['paid'];
  if (modelCaps?.image_input?.supported) details.push('vision');
  if (modelCaps?.pdf_input?.supported) details.push('pdf');
  if (modelCaps?.thinking?.supported) details.push('extended thinking');
  details.push(`max ${formatTokenCount(caps.maxOutputTokens)} out`);
  details.push(`${formatTokenCount(caps.contextWindow)} ctx`);
  return details.join(' · ');
}

function buildModelWarning(modelId: string): string | undefined {
  if (modelId.includes('preview')) return 'preview';
  return undefined;
}

/** Map Anthropic's native `stop_reason` (`end_turn` | `max_tokens` |
 *  `stop_sequence` | `tool_use` | `pause_turn` | `refusal`) to the agent
 *  layer's wire-format `doneReason` set so cross-provider consumers in
 *  `run-agent.ts` see the same vocabulary regardless of which provider
 *  produced the turn:
 *  - `max_tokens` → `'length'` so `output-cap-reached` fires for Anthropic
 *    truncations the same way it does for OpenAI/Ollama.
 *  - `refusal`    → `'refusal'` so `output-blocked` fires when Claude 4.x
 *    declines mid-turn.
 *  - Natural stops (`end_turn`, `stop_sequence`, `tool_use`, `pause_turn`)
 *    return undefined; the agent layer doesn't branch on them. */
function mapAnthropicStopReason(raw: string | null | undefined): string | undefined {
  if (raw === 'max_tokens') return 'length';
  if (raw === 'refusal') return 'refusal';
  return undefined;
}

export interface AnthropicUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function mergeAnthropicUsage(
  prev: AnthropicUsageLike | undefined,
  next: AnthropicUsageLike | undefined,
): AnthropicUsageLike | undefined {
  if (!next) return prev;
  return {
    ...(prev ?? {}),
    ...(next.input_tokens !== undefined ? { input_tokens: next.input_tokens } : {}),
    ...(next.output_tokens !== undefined ? { output_tokens: next.output_tokens } : {}),
    ...(next.cache_read_input_tokens !== undefined
      ? { cache_read_input_tokens: next.cache_read_input_tokens }
      : {}),
    ...(next.cache_creation_input_tokens !== undefined
      ? { cache_creation_input_tokens: next.cache_creation_input_tokens }
      : {}),
  };
}

export function mapAnthropicUsage(u: AnthropicUsageLike): TokenUsage {
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  return {
    promptTokens: input,
    completionTokens: output,
    totalTokens: input + output,
    ...(typeof u.cache_read_input_tokens === 'number'
      ? { cachedPromptTokens: u.cache_read_input_tokens }
      : {}),
    ...(typeof u.cache_creation_input_tokens === 'number'
      ? { cacheCreationTokens: u.cache_creation_input_tokens }
      : {}),
  };
}
