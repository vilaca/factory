import type { ChatMessage } from '../providers/types.js';

const CHARS_PER_TOKEN = 3.5;

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
