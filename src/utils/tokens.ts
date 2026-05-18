import type { ChatMessage } from './chat-message.js';
import type { ToolDefinition } from './tool-definition.js';

/** Approximate char-to-token ratio. Char count is the cheapest available
 *  proxy; provider tokenizers vary but ~4 chars/token holds for English
 *  text and code well enough for heuristics — pre-turn compaction
 *  triggering, recency-window budgeting, and the per-tool-result size cap
 *  in `Conversation.addToolResult`. Provider `promptTokens` floors the
 *  heuristic in `ContextManager.refreshEstimate` (`max(heuristic, floor)`)
 *  once a response returns — see that method for the full estimate. */
export const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Per-message token estimate (content + tool_calls overhead). Does not
 *  include the global conversation overhead (`+3` in `estimateMessagesTokens`). */
export function estimateSingleMessageTokens(message: ChatMessage): number {
  let count = estimateTokens(message.content);
  count += 4; // role / framing overhead
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      count += estimateTokens(tc.function.name);
      try {
        count += estimateTokens(JSON.stringify(tc.function.arguments) ?? '');
      } catch {
        count += 10;
      }
      count += 4;
    }
  }
  return count;
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 3; // conversation overhead
  for (const msg of messages) {
    total += estimateSingleMessageTokens(msg);
  }
  return total;
}

/** Rough token count for native tool definitions JSON shipped with each
 *  request. Pass `[]` when no tools will be sent (text-tool fallback);
 *  the function returns 0 in that case. */
export function estimateToolDefinitionsTokens(definitions: ToolDefinition[]): number {
  if (definitions.length === 0) return 0;
  try {
    return estimateTokens(JSON.stringify(definitions));
  } catch {
    return definitions.length * 80;
  }
}
