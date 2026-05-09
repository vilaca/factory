import type { ChatMessage, ChatOptions, ToolDefinition } from '../types.js';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

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
 *  shape; subsequent system turns stay inline. */
export function buildResponsesBody(opts: BuildResponsesBodyOptions): Record<string, unknown> {
  const { instructions, input } = toResponsesInput(opts.messages);

  const body: Record<string, unknown> = {
    model: opts.model,
    input,
    stream: opts.stream,
    store: false,
  };
  if (instructions) body.instructions = instructions;

  if (opts.tools && opts.tools.length > 0) {
    body.tools = toResponsesTools(opts.tools);
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

/** Map ChatMessage[] into the Responses API `input` array. The first
 *  contiguous system messages collapse into `instructions`; later system
 *  turns become inline messages. Assistant messages with tool_calls split
 *  into one `function_call` item per call (the assistant text, if any,
 *  goes first as a regular message). Tool results become
 *  `function_call_output` items keyed by `call_id`. */
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
 *  (`{type:'function', name, description, parameters, strict}`). */
export function toResponsesTools(tools: ToolDefinition[]): unknown[] {
  return tools.map(t => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
    strict: false,
  }));
}
