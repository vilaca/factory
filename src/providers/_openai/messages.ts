import type { ChatMessage, ChatOptions, ToolDefinition } from '../types.js';

export function formatMessage(msg: ChatMessage): Record<string, unknown> {
  const formatted: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };

  if (msg.tool_calls) {
    formatted.tool_calls = msg.tool_calls.map(tc => ({
      id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: {
        name: tc.function.name,
        arguments: JSON.stringify(tc.function.arguments),
      },
    }));
  }

  if (msg.role === 'tool' && msg.tool_call_id) {
    formatted.tool_call_id = msg.tool_call_id;
  }

  return formatted;
}

export interface BuildChatBodyOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  stream: boolean;
  options?: ChatOptions;
  /**
   * Field name for the per-request output cap. Most OpenAI-compat providers
   * accept `max_completion_tokens`; some still expect the older `max_tokens`.
   * Defaults to `max_completion_tokens`.
   */
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';
  /** Set parallel_tool_calls=true when tools are present. Default true. */
  parallelToolCalls?: boolean;
  /** Extra fields merged into the body (provider-specific knobs). */
  extra?: Record<string, unknown>;
}

export function buildChatBody(opts: BuildChatBodyOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages.map(formatMessage),
    stream: opts.stream,
  };

  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    if (opts.parallelToolCalls !== false) {
      body.parallel_tool_calls = true;
    }
  }
  if (opts.options?.maxTokens) {
    body[opts.maxTokensField ?? 'max_completion_tokens'] = opts.options.maxTokens;
  }
  if (opts.options?.temperature !== undefined) {
    body.temperature = opts.options.temperature;
  }
  if (opts.extra) {
    Object.assign(body, opts.extra);
  }

  return body;
}
