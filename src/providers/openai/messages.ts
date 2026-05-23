import type { ChatMessage, ChatOptions, ToolDefinition } from '../types.js';
import { resolveSampling, applySamplingToBody } from '../shared.js';

// TODO(vision): support multimodal `content` (image_url for chat, input_image
// for Responses). Today ChatMessage.content is `string` (types.ts:7) and ~35
// callsites assume that. Vision-capable models (gpt-4o/4.1/5/o1/o3/o4 — see
// provider.ts:313-325 `vision: true`) currently can't receive images through
// this layer. Scope is its own PR: widen content to `string | ContentPart[]`,
// update formatMessage + toResponsesInput, and audit every msg.content
// reader (conversation history, repeat detector, cache boundaries).
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
  /** Caller-side label routed to `resolveSampling` so the
   *  per-model sampling-defaults diagnostic log fires with the
   *  correct provider attribution. Optional; omitting it suppresses
   *  the log (defaults still apply). */
  providerName?: string;
}

export function buildChatBody(opts: BuildChatBodyOptions): Record<string, unknown> {
  const formatter = opts.cacheControl ? formatMessageWithCacheControl : formatMessage;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages.map(formatter),
    stream: opts.stream,
    // TODO(usage/stream_options): when stream === true, also set
    //   stream_options: { include_usage: true }
    // so the final SSE chunk carries a populated `usage` block. Without
    // this opt-in some OpenAI-compatible endpoints omit usage on streamed
    // responses. Responses API path doesn't need this — it reports usage
    // on response.completed unconditionally.
  };

  if (opts.tools && opts.tools.length > 0) {
    const baseTools = maybeStrictify(opts.tools, opts.options?.toolStrict);
    if (opts.cacheControl && opts.options?.cacheTools) {
      const decorated = baseTools.map((t, i) =>
        i === baseTools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
      );
      body.tools = decorated;
    } else {
      body.tools = baseTools;
    }
    body.parallel_tool_calls = opts.parallelToolCalls ?? true;
  }
  if (opts.options?.maxTokens) {
    body[opts.maxTokensField ?? 'max_completion_tokens'] = opts.options.maxTokens;
  }
  // Phase 10: resolve sampling values from (per-call override → instance
  // defaults → per-model defaults table) and merge into the body. Drops
  // undefined fields, so providers that didn't override anything see no
  // change. `temperature` is included in ResolvedSampling, so the
  // legacy `body.temperature = options.temperature` write is now
  // subsumed.
  const resolved = resolveSampling(opts.options, {
    model: opts.model,
    providerName: opts.providerName,
  });
  applySamplingToBody(body, resolved);
  // TODO(provider-capabilities/openai-options): buildChatBody is reused by
  // multiple "OpenAI-compatible" providers, some of which reject unknown
  // OpenAI-only fields. Gate these pass-through options (and response_format
  // below) behind per-provider capability flags or move this logic to the
  // OpenAI provider-specific body builder.
  applyCommonOpenAiOptions(body, opts.options);
  if (opts.options?.responseFormat) {
    body.response_format = {
      type: 'json_schema',
      json_schema: buildJsonSchemaFormat(opts.options.responseFormat),
    };
  }
  if (opts.extra) {
    Object.assign(body, opts.extra);
  }

  return body;
}

/** Apply the per-option pass-through fields that both /chat/completions and
 *  /responses accept verbatim. Keeping this in one place stops the two body
 *  builders from drifting and keeps each below the cognitive-complexity cap. */
export function applyCommonOpenAiOptions(
  body: Record<string, unknown>,
  options: ChatOptions | undefined,
): void {
  if (!options) return;
  if (options.promptCacheKey) body.prompt_cache_key = options.promptCacheKey;
  if (options.serviceTier) body.service_tier = options.serviceTier;
  if (typeof options.seed === 'number') body.seed = options.seed;
  if (options.safetyIdentifier) body.safety_identifier = options.safetyIdentifier;
  if (options.metadata) body.metadata = options.metadata;
}

/** Pack the user-supplied JSON-schema response-format spec into the shape both
 *  OpenAI APIs expect. The Responses API wraps this further under `text.format`;
 *  chat completions uses `response_format.json_schema`. Shared shape kept here. */
export function buildJsonSchemaFormat(
  rf: NonNullable<ChatOptions['responseFormat']>,
): Record<string, unknown> {
  return {
    name: rf.name,
    schema: rf.schema,
    strict: rf.strict ?? false,
  };
}

/** When `opt` is true, annotate each compatible tool with
 *  `function.strict: true`. Tools whose schema isn't closed-form
 *  (additionalProperties:false, required lists every property, no
 *  oneOf/anyOf — common for third-party / MCP schemas) keep their original
 *  shape, since sending strict:true with a loose schema 400s server-side.
 *
 *  When `opt` is false/undefined we leave every tool untouched — the
 *  `strict` field is omitted entirely. This is deliberate: chat completions
 *  is reached by 10+ OpenAI-compatible backends (cerebras, llamacpp, groq,
 *  openrouter, vercel, workersai, mistral, googleaistudio, copilot,
 *  opencodezen), some of which reject unknown fields. The Responses path
 *  (toResponsesTools) does always emit `strict` because it's OpenAI-only. */
function maybeStrictify(tools: ToolDefinition[], opt: boolean | undefined): ToolDefinition[] {
  if (!opt) return tools;
  return tools.map(t =>
    isStrictCompatible(t.function.parameters)
      ? { ...t, function: { ...t.function, strict: true } }
      : t,
  );
}

/** True when a JSON schema satisfies OpenAI's strict-mode constraints:
 *   - every object sets `additionalProperties: false`,
 *   - every object's `required` lists every key in `properties`,
 *   - every array specifies `items`,
 *   - only primitive/array/object types appear (no oneOf/anyOf, no
 *     unrestricted types).
 *  Conservative: any unknown construct returns false so we never silently
 *  send a schema the API will reject. */
export function isStrictCompatible(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const s = schema as Record<string, unknown>;
  const type = s.type;

  if (type === 'object') {
    if (s.additionalProperties !== false) return false;
    const props = (s.properties as Record<string, unknown> | undefined) ?? {};
    const propKeys = Object.keys(props);
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    // OpenAI strict mode requires every property to appear in `required`.
    if (propKeys.some(k => !required.includes(k))) return false;
    for (const v of Object.values(props)) {
      if (!isStrictCompatible(v)) return false;
    }
    return true;
  }
  if (type === 'array') {
    // Strict mode rejects arrays without an `items` schema.
    return s.items !== undefined && isStrictCompatible(s.items);
  }
  if (
    type === 'string' ||
    type === 'number' ||
    type === 'integer' ||
    type === 'boolean' ||
    type === 'null'
  ) {
    return true;
  }
  // Schemas without a top-level type, or using oneOf/anyOf, or with array
  // types like ["string","null"], are rejected to stay on the safe side. A
  // future iteration can widen this once we have a test corpus of schemas
  // the API actually accepts in strict mode.
  return false;
}
