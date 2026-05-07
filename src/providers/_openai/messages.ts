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

/** Same as formatMessage, plus translates `cacheBoundary: true` into an
 *  Anthropic-style `cache_control: { type: 'ephemeral' }` block on the
 *  message content. Used by OpenAI-compat providers that proxy to
 *  Anthropic upstreams (OpenRouter) — the upstream forwards the field
 *  verbatim. Other OpenAI-compat providers must NOT send this field, so
 *  the transformation is opt-in via the `cacheControl` flag in
 *  `buildChatBody`. */
function formatMessageWithCacheControl(msg: ChatMessage): Record<string, unknown> {
  const base = formatMessage(msg);
  if (!msg.cacheBoundary) return base;
  // Convert plain string content into a single text block carrying the
  // marker. Tool messages already have string content; assistant messages
  // with tool_calls keep their string-or-empty content unchanged on the
  // OpenAI side (cache_control rides on the trailing block — for OpenAI
  // shape that means the content text block).
  const text = typeof base.content === 'string' ? base.content : '';
  return {
    ...base,
    content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }],
  };
}

interface BuildChatBodyOptions {
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
  /** Opt-in: translate `cacheBoundary` on messages and `options.cacheTools`
   *  into Anthropic-style `cache_control: { type: 'ephemeral' }` blocks.
   *  Default off — only safe when the upstream is Anthropic (e.g.
   *  OpenRouter routing to `anthropic/claude-*`). */
  cacheControl?: boolean;
}

export function buildChatBody(opts: BuildChatBodyOptions): Record<string, unknown> {
  const formatter = opts.cacheControl ? formatMessageWithCacheControl : formatMessage;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages.map(formatter),
    stream: opts.stream,
  };

  if (opts.tools && opts.tools.length > 0) {
    if (opts.cacheControl && opts.options?.cacheTools) {
      const decorated = opts.tools.map((t, i) =>
        i === opts.tools!.length - 1
          ? { ...t, cache_control: { type: 'ephemeral' } }
          : t,
      );
      body.tools = decorated;
    } else {
      body.tools = opts.tools;
    }
    body.parallel_tool_calls = opts.parallelToolCalls ?? true;
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
