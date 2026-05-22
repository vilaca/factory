import type { ToolDefinition, ToolHandler, ToolResult } from './types.js';
import { TOOL_NAMES } from './types.js';

const definition: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAMES.Respond,
    // Description lifted verbatim from the reliability spec (docs/reliability/next-steps.md §13).
    // Wording is load-bearing: the model is supposed to read this and treat
    // `Respond` as the structured terminal action when no other tool action
    // is needed, instead of guessing between "emit text" and "call a tool".
    description:
      "Respond to the user with a message. Use this when the user is chatting, asking a question, when you need to ask a clarifying question before proceeding, or when no other tool action is needed. Also use this after completing the user's request to report the result.",
    parameters: {
      type: 'object',
      required: ['message'],
      properties: {
        message: {
          type: 'string',
          description: 'The text to deliver to the user.',
        },
      },
    },
  },
};

/** Echoes the message back as the tool's output. The agent loop normally
 *  short-circuits a single `Respond` batch before this executes (see
 *  `run-agent.ts` — the model's `message` is yielded as `text-done` and the
 *  turn completes). This fallback covers cases where `Respond` arrives
 *  alongside other tool calls in the same batch, where the natural read
 *  is "deliver this message, then continue with the rest" rather than
 *  terminate. */
async function execute(args: Record<string, unknown>): Promise<ToolResult> {
  const message = typeof args.message === 'string' ? args.message : '';
  if (!message) {
    return { success: false, output: 'message is required' };
  }
  return { success: true, output: message };
}

export const respondTool: ToolHandler = {
  name: TOOL_NAMES.Respond,
  description: definition.function.description,
  category: 'read-only',
  definition,
  execute,
};
