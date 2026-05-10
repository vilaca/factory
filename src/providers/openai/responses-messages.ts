import type {
  ChatMessage,
  ChatOptions,
  ReasoningEffort,
  ToolDefinition,
} from '../types.js';

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
  const store = opts.options?.responsesStore ?? true;
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
  if (chain) body.previous_response_id = chain.lastResponseId;
  if (instructions) body.instructions = instructions;

  if (opts.tools && opts.tools.length > 0) {
    body.tools = toResponsesTools(opts.tools, opts.options?.toolStrict ?? false);
    body.parallel_tool_calls = opts.parallelToolCalls ?? true;
  }
  if (opts.options?.maxTokens) {
    body.max_output_tokens = opts.options.maxTokens;
  }
  if (opts.reasoningEffort) {
    body.reasoning = { effort: opts.reasoningEffort };
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
 *  (`{type:'function', name, description, parameters, strict}`). The `strict`
 *  flag is caller-supplied (defaults false at the body builder via
 *  `options.toolStrict`) — turning it on requires every tool's `parameters`
 *  schema to be fully closed-form (`additionalProperties: false`, no
 *  unconstrained types), which arbitrary MCP tools won't always satisfy. */
export function toResponsesTools(tools: ToolDefinition[], strict: boolean): unknown[] {
  return tools.map(t => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
    strict,
  }));
}
