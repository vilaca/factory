import type { ChatMessage, ChatOptions, ReasoningEffort, ToolDefinition } from '../types.js';
import { applyCommonOpenAiOptions, buildJsonSchemaFormat, isStrictCompatible } from './messages.js';

interface BuildResponsesBodyOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  stream: boolean;
  options?: ChatOptions;
  parallelToolCalls?: boolean;
  /** Optional pin; when undefined the server picks the family default. */
  reasoningEffort?: ReasoningEffort;
}

/** Resolve the effective `store` flag. Precedence: explicit per-call
 *  override (opts.options.responsesStore) → env (FACTORY_OPENAI_RESPONSES_STORE)
 *  → default true. The env variable is the short-term escape hatch for users
 *  who need server-side opt-out before a proper config-schema field lands.
 *
 *  TODO(config/responsesStore): plumb ChatOptions.responsesStore (types.ts:120)
 *  through the user-facing config so it isn't only env-overridable. When
 *  that lands, drop the env path.
 *  TODO(config/pure-builders): keep request-body builders pure by resolving
 *  env/config once in provider construction and passing the effective value
 *  via ChatOptions; avoid direct process.env reads in this module. */
function resolveStore(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  const raw = process.env.FACTORY_OPENAI_RESPONSES_STORE;
  if (raw === 'false' || raw === '0') return false;
  return true;
}

/** OpenAI Responses API request body. Different shape from chat-completions:
 *  uses `input` (not `messages`), flat tool definitions, `max_output_tokens`
 *  instead of `max_completion_tokens`, and accepts a `reasoning` block. The
 *  first system message is hoisted to `instructions` per the API's preferred
 *  shape; subsequent system turns stay inline.
 *  Ref: https://platform.openai.com/docs/api-reference/responses
 *
 *  When `options.responsesChain` is set the input is sliced to messages
 *  produced after the captured count, and `previous_response_id` continues
 *  the server-side chain — codex reuses prior reasoning tokens instead of
 *  re-deriving them, which is the whole point of this transport.
 *
 *  `store` defaults to true on this path: even when no chain pointer is
 *  active on this call, the response is retained server-side so the *next*
 *  call can chain off it. Callers may override with `options.responsesStore`
 *  when policy requires opt-out — chaining is incompatible with store=false
 *  (an unstored response can't be referenced by a later `previous_response_id`),
 *  so the chain pointer is dropped on this call when store is off. */
export function buildResponsesBody(opts: BuildResponsesBodyOptions): Record<string, unknown> {
  const store = resolveStore(opts.options?.responsesStore);
  // When store is off, the resulting response is not retained server-side and
  // can't anchor a future chain. Honoring the inbound chain pointer would
  // either send a `previous_response_id` for an unstored prior response (404)
  // or slice off messages the server never saw — both wrong. Drop the chain.
  const chain = store ? opts.options?.responsesChain : undefined;
  const messages = chain ? opts.messages.slice(chain.messageCount) : opts.messages;
  const { instructions, input } = toResponsesInput(messages);

  const body: Record<string, unknown> = {
    model: opts.model,
    input,
    stream: opts.stream,
    store,
  };
  // TODO: wire OpenAI Responses `background: true` for genuinely long-running
  // jobs (10min+), with polling/reattach semantics in the agent loop. The
  // streaming transport intentionally enforces a short idle timeout.
  if (chain) body.previous_response_id = chain.lastResponseId;
  if (instructions) body.instructions = instructions;

  if (opts.tools && opts.tools.length > 0) {
    body.tools = toResponsesTools(opts.tools, opts.options?.toolStrict ?? false);
    body.parallel_tool_calls = opts.parallelToolCalls ?? true;
  }
  if (opts.options?.maxTokens) {
    body.max_output_tokens = opts.options.maxTokens;
  }
  if (opts.reasoningEffort || opts.options?.reasoningSummary) {
    const reasoning: Record<string, unknown> = {};
    if (opts.reasoningEffort) reasoning.effort = opts.reasoningEffort;
    if (opts.options?.reasoningSummary) reasoning.summary = opts.options.reasoningSummary;
    body.reasoning = reasoning;
  }
  // When server-side storage is off, request client-returnable encrypted
  // reasoning so the agent layer can re-attach reasoning continuity on the
  // next call instead of starting cold. The capture/replay half of this
  // feature is not yet wired — see TODO at responses-stream.ts:isChainable.
  if (!store) {
    body.include = ['reasoning.encrypted_content'];
  }
  applyCommonOpenAiOptions(body, opts.options);
  if (opts.options?.truncationAuto) {
    body.truncation = 'auto';
  }
  if (opts.options?.responseFormat) {
    body.text = {
      format: { type: 'json_schema', ...buildJsonSchemaFormat(opts.options.responseFormat) },
    };
  }
  return body;
}

interface ResponsesInputResult {
  instructions?: string;
  input: unknown[];
}

/** Map ChatMessage[] into the Responses API `input` array. A system message
 *  at index 0 is hoisted into `instructions`; any other system messages
 *  (including a second one at index 1) stay inline as regular `message`
 *  items. Assistant messages with tool_calls split into one `function_call`
 *  item per call (the assistant text, if any, goes first as a regular
 *  message). Tool results become `function_call_output` items keyed by
 *  `call_id`. */
export function toResponsesInput(messages: ChatMessage[]): ResponsesInputResult {
  let instructions: string | undefined;
  const input: unknown[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === 'system' && instructions === undefined && i === 0) {
      instructions = msg.content;
      continue;
    }
    if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id ?? '',
        output: msg.content,
      });
      continue;
    }
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      if (msg.content) {
        input.push({ type: 'message', role: 'assistant', content: msg.content });
      }
      for (const tc of msg.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id ?? '',
          name: tc.function.name,
          arguments: JSON.stringify(tc.function.arguments),
        });
      }
      continue;
    }
    input.push({ type: 'message', role: msg.role, content: msg.content });
  }

  return instructions !== undefined ? { instructions, input } : { input };
}

/** Unwrap chat-completions tool shape (`{type:'function', function:{name,
 *  description, parameters}}`) into the Responses API's flat shape
 *  (`{type:'function', name, description, parameters, strict}`). When
 *  `strict` is true we still gate per-tool on schema compatibility:
 *  strict mode requires `additionalProperties: false` on every object and
 *  standard JSON-schema types only. Tools that don't satisfy this — common
 *  for third-party (MCP) schemas — keep `strict: false` so the request as
 *  a whole still passes. */
export function toResponsesTools(tools: ToolDefinition[], strict: boolean): unknown[] {
  return tools.map(t => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
    strict: strict && isStrictCompatible(t.function.parameters),
  }));
}
