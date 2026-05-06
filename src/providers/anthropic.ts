import Anthropic from '@anthropic-ai/sdk';
import type {
  Provider, ChatMessage, ChatChunk, ToolDefinition,
  ToolCallMessage, ProviderCapabilities, ChatOptions,
} from './types.js';

export class AnthropicProvider implements Provider {
  name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        'Anthropic API key required. Set ANTHROPIC_API_KEY env var or use --token flag.'
      );
    }
    this.client = new Anthropic({ apiKey: key });
  }

  async listModels(): Promise<string[]> {
    // Note: Anthropic discovery is still a curated allowlist of the main chat
    // families we expect to work well here, not a live API catalog.
    return [
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-haiku-4-5-20251001',
    ];
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

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<ChatChunk> {
    const { system, msgs } = this.splitMessages(messages);

    const params: any = {
      model,
      max_tokens: options?.maxTokens ?? 8192,
      system: system ?? undefined,
      messages: msgs,
      stream: true,
    };

    if (tools && tools.length > 0) {
      params.tools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description ?? '',
        input_schema: t.function.parameters,
      }));
    }

    const stream = this.client.messages.stream(params);

    let currentToolCall: { id: string; name: string; rawArgs: string } | null = null;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block as any;
        if (block.type === 'tool_use') {
          currentToolCall = { id: block.id, name: block.name, rawArgs: '' };
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta as any;
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
            tool_calls: [{
              id: currentToolCall.id,
              function: { name: currentToolCall.name, arguments: args },
            }],
          };
          currentToolCall = null;
        }
      } else if (event.type === 'message_stop') {
        yield { done: true };
      } else if (event.type === 'message_delta') {
        const delta = event as any;
        if (delta.usage) {
          const cacheRead = delta.usage.cache_read_input_tokens;
          const cacheCreation = delta.usage.cache_creation_input_tokens;
          const usage: any = {
            promptTokens: delta.usage.input_tokens ?? 0,
            completionTokens: delta.usage.output_tokens ?? 0,
            totalTokens: (delta.usage.input_tokens ?? 0) + (delta.usage.output_tokens ?? 0),
          };
          if (typeof cacheRead === 'number') usage.cachedPromptTokens = cacheRead;
          if (typeof cacheCreation === 'number') usage.cacheCreationTokens = cacheCreation;
          yield { done: true, usage };
        }
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

    const params: any = {
      model,
      max_tokens: options?.maxTokens ?? 8192,
      system: system ?? undefined,
      messages: msgs,
    };

    if (tools && tools.length > 0) {
      params.tools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description ?? '',
        input_schema: t.function.parameters,
      }));
    }

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

    const respUsage = (response as any).usage ?? {};
    const cacheRead = respUsage.cache_read_input_tokens;
    const cacheCreation = respUsage.cache_creation_input_tokens;
    const usage: any = {
      promptTokens: respUsage.input_tokens ?? 0,
      completionTokens: respUsage.output_tokens ?? 0,
      totalTokens: (respUsage.input_tokens ?? 0) + (respUsage.output_tokens ?? 0),
    };
    if (typeof cacheRead === 'number') usage.cachedPromptTokens = cacheRead;
    if (typeof cacheCreation === 'number') usage.cacheCreationTokens = cacheCreation;
    return {
      content: content || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      done: true,
      usage,
    };
  }

  private splitMessages(messages: ChatMessage[]): { system: string | null; msgs: any[] } {
    return splitMessagesForAnthropic(messages);
  }
}

export function splitMessagesForAnthropic(
  messages: ChatMessage[],
): { system: string | null; msgs: any[] } {
  let system: string | null = null;
  const msgs: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system = msg.content;
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      const content: any[] = [];
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
      const block = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: msg.content,
      };
      // Anthropic requires all tool_results from one turn to share a single
      // user message that immediately follows the assistant's tool_use
      // blocks. Coalesce consecutive tool messages into one user message.
      const last = msgs[msgs.length - 1];
      if (
        last?.role === 'user' &&
        Array.isArray(last.content) &&
        last.content.every((b: any) => b?.type === 'tool_result')
      ) {
        last.content.push(block);
      } else {
        msgs.push({ role: 'user', content: [block] });
      }
    } else {
      msgs.push({ role: msg.role, content: msg.content });
    }
  }

  return { system, msgs };
}
