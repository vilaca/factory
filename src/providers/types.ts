import type { ToolDefinition } from '../utils/tool-definition.js';
import type { ChatMessage, ToolCallMessage } from '../utils/chat-message.js';

export type { ToolDefinition, ChatMessage, ToolCallMessage };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Input tokens served from the provider's prompt cache. Optional —
   * providers that don't surface a cache split leave this undefined. */
  cachedPromptTokens?: number;
  /** Input tokens written into the cache on this turn (Anthropic-style
   * explicit caching). Optional. */
  cacheCreationTokens?: number;
  /** Hidden-reasoning output tokens (OpenAI o-series, codex via the
   * Responses API). Counted *inside* completionTokens; surfaced separately
   * so the UI can split "thinking vs answer" cost. Undefined for providers
   * that don't expose the breakdown. */
  reasoningTokens?: number;
}

export interface ChatChunk {
  content?: string;
  tool_calls?: ToolCallMessage[];
  /** Streaming providers MAY emit more than one `done: true` chunk per call.
   *  The OpenAI chat stream, for example, yields a first `done` carrying
   *  `doneReason` and `usage` when `finish_reason` arrives in the SSE
   *  channel, then a second `done` carrying finalized `tool_calls` after
   *  delta accumulation completes. Consumers must iterate to the generator's
   *  actual end and merge fields chunk-by-chunk; do not break on the first
   *  `done: true` or tool calls will be lost. */
  done?: boolean;
  usage?: TokenUsage;
  /** Provider-supplied stop reason on the final chunk. Ollama uses values like
   * "stop" (natural), "length" (hit num_predict), "load" (model still loading). */
  doneReason?: string;
  /** Stored-response id from OpenAI's /v1/responses, set on the terminal
   *  chunk. The agent loop captures it into a per-session ResponsesChain so
   *  the next call can pass `previous_response_id` and reuse server-side
   *  reasoning tokens — codex generates 5–15k of these per turn at output
   *  rates, so reuse is a real cost reduction. Other providers leave it
   *  undefined. */
  responseId?: string;
}

type ToolSupportLevel = 'native' | 'basic' | 'none';
export type ModelTier = 'strong' | 'medium' | 'weak';
type TokenCountingMethod = 'exact' | 'estimated';

/** Reasoning effort hint passed through to providers that expose a native
 *  reasoning control. OpenAI Responses API maps this to `reasoning.effort`
 *  (https://platform.openai.com/docs/guides/reasoning). Other providers
 *  (Anthropic `thinking`, Google `thinkingConfig`) can map the same enum to
 *  their own shapes when wired. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface ProviderCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  toolSupport: ToolSupportLevel;
  parallelToolCalls: boolean;
  streaming: boolean;
  tokenCounting: TokenCountingMethod;
  modelTier: ModelTier;
  /** True for coding-specialist fine-tunes (codex, coder). Used by the
   *  picker to float them above generic flagships within the same tier
   *  since this CLI is a coding agent. Inferred via generic substring
   *  match — no per-family table needed. */
  codingSpecialist?: boolean;
}

export interface ModelInfo {
  supportsTools: boolean;
  capabilities?: string[];
}

export interface ModelPickerInfo {
  label?: string;
  detail?: string;
  warning?: string;
}

/**
 * Source label for an outgoing LLM call. Used by `instrumentProviderRequests`
 * (and the session log via `logModelRequest`) to bucket requests by which
 * subsystem issued them. Defined here so the per-call override hook on
 * `ChatOptions._requestSource` doesn't pull in a cycle from instrument.ts.
 */
export type ModelRequestSource = 'main' | 'compaction' | 'corrector' | 'subagent';

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Per-call override for the request-source tag read by the
   *  `instrumentProviderRequests` wrapper. The same wrapped Provider instance
   *  is reused by the main agent loop, the tool-call corrector
   *  (`tool-call-corrector.ts`), and the compaction summary
   *  (`context-manager.ts`), so the wrap-time `defaultSource` would mis-bucket
   *  those callers as `main`. Providers strip unknown options — this field
   *  exists only for the logging wrapper and is invisible to network code. */
  _requestSource?: ModelRequestSource;
  /** Hint to providers that support explicit cache markers (Anthropic,
   * OpenRouter→Anthropic) to cache the tool definitions. Vendor-neutral:
   * other providers ignore. Pairs with `cacheBoundary` on ChatMessage so
   * the agent layer has a single decision point for cache placement. */
  cacheTools?: boolean;
  /** Active OpenAI Responses-API chain pointer. When set on a /v1/responses
   *  call, the body is built with `previous_response_id` and the input is
   *  trimmed to messages.slice(messageCount). Providers that don't speak
   *  the Responses API ignore this. Pairs with ChatChunk.responseId for
   *  capture on the way out. */
  responsesChain?: { lastResponseId: string; messageCount: number };
  /** OpenAI Responses API persistence toggle. Defaults to true when omitted so
   *  codex turns can chain via `previous_response_id`. Set false to opt out of
   *  server-side storage on providers that honor this flag. */
  responsesStore?: boolean;
  /** Responses-API tool strictness hint. When true, providers that support
   *  strict JSON-schema tool calling set the equivalent native flag. */
  toolStrict?: boolean;
  /** Reasoning effort override. When unset, providers pick a per-model
   *  default. Providers without a native reasoning control ignore. */
  reasoningEffort?: ReasoningEffort;
  /** Reasoning summary visibility for the OpenAI Responses API. When set,
   *  the request asks the model to emit `response.reasoning_summary_text.delta`
   *  events at the chosen granularity. We already surface those events as
   *  text deltas (responses-stream.ts), but the model only emits them when
   *  asked. Providers that don't speak the Responses API ignore. */
  reasoningSummary?: 'auto' | 'concise' | 'detailed';
  /** OpenAI prompt cache partitioning key. When the same prefix is sent
   *  from many concurrent sessions, supplying a stable key per logical
   *  session improves the hit rate vs the auto-derived prefix hash.
   *  Providers other than OpenAI / OpenAI-compatible ignore. */
  promptCacheKey?: string;
  /** OpenAI service tier knob. `flex` is ~50% cheaper but higher latency;
   *  `priority` is faster at premium price; `auto` (server-chosen) and
   *  `default` cover the common cases. Providers without an equivalent
   *  ignore. */
  serviceTier?: 'auto' | 'default' | 'flex' | 'priority';
  /** Deterministic-sampling seed. When set, identical inputs yield the
   *  same output across calls (best-effort — reasoning models still vary
   *  because hidden CoT sampling isn't seedable). Useful for evals and
   *  reproducible bug reports. */
  seed?: number;
  /** Stable hash of the end-user identifier. OpenAI uses this for abuse-
   *  pattern detection and recommends sending one in production traffic.
   *  Replaces the legacy `user` field. */
  safetyIdentifier?: string;
  /** Up to 16 free-form key/value pairs the server attaches to the
   *  response record. Filterable in the OpenAI dashboard and via
   *  responses-retrieval. Useful for telemetry binding (session id,
   *  feature flag values, etc.). */
  metadata?: Record<string, string>;
  /** When true, send `truncation: "auto"` so the OpenAI Responses API
   *  trims the start of `input` when it would exceed the model's context
   *  window, instead of failing the call. Only honored on the Responses
   *  path. */
  truncationAuto?: boolean;
  /** Constrain the model's output to a JSON schema. Maps to OpenAI's
   *  `response_format: { type: "json_schema", json_schema: {...} }` on
   *  chat completions, and to `text.format` on Responses. When set,
   *  callers should not also rely on tool calling for the same output. */
  responseFormat?: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface Provider {
  name: string;
  listModels(): Promise<string[]>;
  getDisplayModelName?(model: string): string;
  getModelPickerInfo?(model: string): ModelPickerInfo;
  getCapabilities(model: string): ProviderCapabilities;
  getModelInfo?(model: string): Promise<ModelInfo>;
  /** Best-effort warm-up for any per-model caches a provider relies on for
   *  the synchronous `getCapabilities` path (e.g. ollama's `/api/show` →
   *  context_length lookup). Implementations must swallow transient errors;
   *  a failed prime should leave callers free to proceed with estimates. */
  primeModelCache?(model: string): Promise<void>;
  chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk>;
  chatNoStream(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatChunk>;
  countTokens?(messages: ChatMessage[]): Promise<number>;
}
