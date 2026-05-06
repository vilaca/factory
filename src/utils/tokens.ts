import type { ChatMessage } from '../providers/types.js';

/** Approximate char-to-token ratio. Char count is the cheapest available
 *  proxy; provider tokenizers vary but ~4 chars/token holds for English
 *  text and code well enough for the heuristics that depend on this — pre-
 *  turn compaction triggering, recency-window budgeting, and the per-tool-
 *  result size cap in Conversation.addToolResult. Real usage from the
 *  provider replaces the estimate as soon as the first turn returns. */
export const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateMessageTokens(message: ChatMessage): number {
  let count = estimateTokens(message.content);
  // Overhead for role, formatting
  count += 4;
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      count += estimateTokens(tc.function.name);
      try {
        count += estimateTokens(JSON.stringify(tc.function.arguments) ?? '');
      } catch {
        count += 10; // fallback estimate for unparseable arguments
      }
      count += 4;
    }
  }
  return count;
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 3; // conversation overhead
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}
