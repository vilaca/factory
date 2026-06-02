// Anthropic-Messages route adapter for OpenCode Zen.
//
// Zen exposes Claude models behind an Anthropic-compatible API; we go
// through the official @anthropic-ai SDK so the streaming-event shape
// (content_block_start / message_delta usage) matches what Anthropic
// emits directly. Translation to/from the provider-neutral ChatMessage
// shape stays here so the orchestrator file doesn't have to know SDK
// internals.

import type Anthropic from '@anthropic-ai/sdk';
import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ToolCallMessage,
  ToolDefinition,
} from '../types.js';
import { estimateMaxOutput, parseToolArgs } from './models.js';

type AnthropicStreamingParams = Anthropic.Messages.MessageCreateParamsStreaming;
type AnthropicNonStreamingParams = Anthropic.Messages.MessageCreateParamsNonStreaming;
type AnthropicMessageParam = Anthropic.Messages.MessageParam;
type AnthropicContentBlockParam = Anthropic.Messages.ContentBlockParam;

/**
 * Convert provider-neutral ChatMessages into Anthropic's expected shape:
 * a separate top-level `system` string plus a messages array where every
 * tool use/result is encoded as a typed content block, not a separate
 * role. Pure function — caller-friendly for tests.
 */
function splitAnthropicMessages(messages: ChatMessage[]): {
  system: string | null;
  msgs: AnthropicMessageParam[];
} {
  let system: string | null = null;
  const msgs: AnthropicMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system = msg.content;
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      const content: AnthropicContentBlockParam[] = [];
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
      const lastAssistant = msgs[msgs.length - 1];
      let toolUseId = 'unknown';
      if (lastAssistant?.role === 'assistant' && Array.isArray(lastAssistant.content)) {
        for (let j = lastAssistant.content.length - 1; j >= 0; j--) {
          const b = lastAssistant.content[j]!;
          if (b.type === 'tool_use') {
            toolUseId = b.id;
            break;
          }
        }
      }
      msgs.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: msg.content,
          },
        ],
      });
    } else {
      msgs.push({ role: msg.role, content: msg.content });
    }
  }

  return { system, msgs };
}

function buildToolsParam(tools: ToolDefinition[] | undefined):
  | {
      tools: Array<{
        name: string;
        description: string;
        input_schema: Anthropic.Messages.Tool.InputSchema;
      }>;
    }
  | Record<string, never> {
  if (!tools || tools.length === 0) return {};
  return {
    tools: tools.map(t => ({
      name: t.function.name,
      description: t.function.description ?? '',
      input_schema: t.function.parameters as Anthropic.Messages.Tool.InputSchema,
    })),
  };
}

export async function* chatAnthropicStream(
  client: Anthropic,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  options: ChatOptions | undefined,
): AsyncGenerator<ChatChunk> {
  const { system, msgs } = splitAnthropicMessages(messages);

  const params: AnthropicStreamingParams = {
    model,
    max_tokens: options?.maxTokens ?? estimateMaxOutput(model.toLowerCase()),
    messages: msgs,
    stream: true,
    ...(system !== null ? { system } : {}),
    ...buildToolsParam(tools),
  };

  const stream = client.messages.stream(params, { signal: options?.signal });

  let currentToolCall: { id: string; name: string; rawArgs: string } | null = null;
  let usageSnapshot: {
    input_tokens?: number | null;
    output_tokens?: number | null;
  } | null = null;
  let sawTerminalChunk = false;

  for await (const event of stream) {
    if (event.type === 'message_start') {
      usageSnapshot = {
        ...(usageSnapshot ?? {}),
        ...(event.message.usage.input_tokens !== undefined
          ? { input_tokens: event.message.usage.input_tokens }
          : {}),
        ...(event.message.usage.output_tokens !== undefined
          ? { output_tokens: event.message.usage.output_tokens }
          : {}),
      };
    } else if (event.type === 'content_block_start') {
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
        yield {
          tool_calls: [
            {
              id: currentToolCall.id,
              function: {
                name: currentToolCall.name,
                arguments: parseToolArgs(currentToolCall.rawArgs),
              },
            },
          ],
        };
        currentToolCall = null;
      }
    } else if (event.type === 'message_delta') {
      const u = event.usage;
      usageSnapshot = {
        ...(usageSnapshot ?? {}),
        ...(u.input_tokens !== undefined ? { input_tokens: u.input_tokens } : {}),
        ...(u.output_tokens !== undefined ? { output_tokens: u.output_tokens } : {}),
      };
      sawTerminalChunk = true;
      yield {
        done: true,
        ...(usageSnapshot
          ? {
              usage: {
                promptTokens: usageSnapshot.input_tokens ?? 0,
                completionTokens: usageSnapshot.output_tokens ?? 0,
                totalTokens: (usageSnapshot.input_tokens ?? 0) + (usageSnapshot.output_tokens ?? 0),
              },
            }
          : {}),
      };
    } else if (event.type === 'message_stop') {
      if (sawTerminalChunk) continue;
      yield {
        done: true,
        ...(usageSnapshot
          ? {
              usage: {
                promptTokens: usageSnapshot.input_tokens ?? 0,
                completionTokens: usageSnapshot.output_tokens ?? 0,
                totalTokens: (usageSnapshot.input_tokens ?? 0) + (usageSnapshot.output_tokens ?? 0),
              },
            }
          : {}),
      };
    }
  }
}

export async function chatAnthropicNoStream(
  client: Anthropic,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  options: ChatOptions | undefined,
): Promise<ChatChunk> {
  const { system, msgs } = splitAnthropicMessages(messages);

  const params: AnthropicNonStreamingParams = {
    model,
    max_tokens: options?.maxTokens ?? estimateMaxOutput(model.toLowerCase()),
    messages: msgs,
    ...(system !== null ? { system } : {}),
    ...buildToolsParam(tools),
  };

  const response = await client.messages.create(params, { signal: options?.signal });

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
  return {
    content: content || undefined,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    done: true,
    usage: {
      promptTokens: u.input_tokens ?? 0,
      completionTokens: u.output_tokens ?? 0,
      totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
    },
  };
}
