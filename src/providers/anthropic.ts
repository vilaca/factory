import Anthropic from '@anthropic-ai/sdk';
import type {
  Provider,
  ChatMessage,
  ChatChunk,
  TokenUsage,
  ToolDefinition,
  ToolCallMessage,
  ProviderCapabilities,
  ChatOptions,
} from './types.js';

type StreamingParams = Anthropic.Messages.MessageCreateParamsStreaming;
type NonStreamingParams = Anthropic.Messages.MessageCreateParamsNonStreaming;
type MessageParam = Anthropic.Messages.MessageParam;
type ToolUnion = Anthropic.Messages.ToolUnion;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;

export class AnthropicProvider implements Provider {
  name = 'anthropic';
  private client: Anthropic;

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
    // Note: Anthropic discovery is still a curated allowlist of the main chat
    // families we expect to work well here, not a live API catalog.
    return ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'];
  }

  getCapabilities(model: string): ProviderCapabilities {
    const lower = model.toLowerCase();
    if (lower.includes('opus')) {
      return {
        contextWindow: 200000,
        maxOutputTokens: 32000,
        toolSupport: 'native',
        parallelToolCalls: true,
        streaming: true,
        tokenCounting: 'exact',
        modelTier: 'strong',
      };
    }
    if (lower.includes('haiku')) {
      return {
        contextWindow: 200000,
        maxOutputTokens: 8192,
        toolSupport: 'native',
        parallelToolCalls: true,
        streaming: true,
        tokenCounting: 'exact',
        modelTier: 'medium',
      };
    }
    // Sonnet (default)
    return {
      contextWindow: 200000,
      maxOutputTokens: 16000,
      toolSupport: 'native',
      parallelToolCalls: true,
      streaming: true,
      tokenCounting: 'exact',
      modelTier: 'strong',
    };
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(complexity): split request build / stream parse / usage emit.
  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const { system, msgs } = this.splitMessages(messages);

    const params: StreamingParams = {
      model,
      max_tokens: options?.maxTokens ?? 8192,
      messages: msgs,
      stream: true,
      ...(system !== null ? { system } : {}),
      ...(tools && tools.length > 0
        ? { tools: buildAnthropicTools(tools, options?.cacheTools) }
        : {}),
    };

    const stream = this.client.messages.stream(params);

    let currentToolCall: { id: string; name: string; rawArgs: string } | null = null;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          currentToolCall = { id: block.id, name: block.name, rawArgs: '' };
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          yield { content: delta.text };
        } else if (delta.type === 'input_json_delta' && currentToolCall) {
          currentToolCall.rawArgs += delta.partial_json;
        }
      } else if (event.type === 'content_block_stop') {
        if (currentToolCall) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(currentToolCall.rawArgs);
          } catch {
            args = { _raw: currentToolCall.rawArgs };
          }
          yield {
            tool_calls: [
              {
                id: currentToolCall.id,
                function: { name: currentToolCall.name, arguments: args },
              },
            ],
          };
          currentToolCall = null;
        }
      } else if (event.type === 'message_stop') {
        yield { done: true };
      } else if (event.type === 'message_delta') {
        const u = event.usage;
        const usage: TokenUsage = {
          promptTokens: u.input_tokens ?? 0,
          completionTokens: u.output_tokens ?? 0,
          totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
          ...(typeof u.cache_read_input_tokens === 'number'
            ? { cachedPromptTokens: u.cache_read_input_tokens }
            : {}),
          ...(typeof u.cache_creation_input_tokens === 'number'
            ? { cacheCreationTokens: u.cache_creation_input_tokens }
            : {}),
        };
        yield { done: true, usage };
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

    const params: NonStreamingParams = {
      model,
      max_tokens: options?.maxTokens ?? 8192,
      messages: msgs,
      ...(system !== null ? { system } : {}),
      ...(tools && tools.length > 0
        ? { tools: buildAnthropicTools(tools, options?.cacheTools) }
        : {}),
    };

    const response = await this.client.messages.create(params);

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

    const u = response.usage;
    const usage: TokenUsage = {
      promptTokens: u.input_tokens ?? 0,
      completionTokens: u.output_tokens ?? 0,
      totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      ...(typeof u.cache_read_input_tokens === 'number'
        ? { cachedPromptTokens: u.cache_read_input_tokens }
        : {}),
      ...(typeof u.cache_creation_input_tokens === 'number'
        ? { cacheCreationTokens: u.cache_creation_input_tokens }
        : {}),
    };
    return {
      content: content || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      done: true,
      usage,
    };
  }

  private splitMessages(
    messages: ChatMessage[],
  ): { system: StreamingParams['system'] | null; msgs: MessageParam[] } {
    return splitMessagesForAnthropic(messages);
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

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemContent = msg.content;
      if (msg.cacheBoundary) systemCacheBoundary = true;
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      const content: ContentBlockParam[] = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id ?? `toolu_${Math.random().toString(36).slice(2, 14)}`,
          name: tc.function.name,
          input: tc.function.arguments,
        });
      }
      if (msg.cacheBoundary && content.length > 0) {
        content[content.length - 1] = {
          ...content[content.length - 1]!,
          cache_control: { type: 'ephemeral' },
        } as ContentBlockParam;
      }
      msgs.push({ role: 'assistant', content });
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
    } else {
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
