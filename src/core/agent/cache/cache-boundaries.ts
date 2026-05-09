import type { ChatMessage } from '../../../providers/types.js';

/**
 * Annotate a copy of `messages` with `cacheBoundary: true` at the positions
 * a vendor-neutral cache marker should live for the upcoming provider.chat
 * call. Two boundaries are placed when applicable:
 *
 * 1. The system message — caches the system prompt + tool definitions.
 * 2. The most recent assistant message that isn't the trailing message —
 *    caches everything in the conversation up to "the last completed
 *    exchange before the new user input". When the array ends in an
 *    assistant message (no pending user prompt), no second marker is
 *    placed; the next call will get one once a new user message lands.
 *
 * Tools-array caching lives outside this function — see ChatOptions.cacheTools
 * (the third Anthropic marker, applied by the Anthropic provider directly).
 *
 * Providers that don't support explicit cache markers (everything
 * non-Anthropic) ignore `cacheBoundary` entirely; this function is
 * vendor-neutral.
 */
export function applyCacheBoundaries(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();

  for (let i = 0; i < out.length; i++) {
    if (out[i]!.role === 'system') {
      out[i] = { ...out[i]!, cacheBoundary: true };
      break;
    }
  }

  let lastAssistantIdx = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]!.role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx >= 0 && lastAssistantIdx < out.length - 1) {
    out[lastAssistantIdx] = { ...out[lastAssistantIdx]!, cacheBoundary: true };
  }

  return out;
}

/** Number of cacheBoundary markers in the array. Anthropic caps at 4 across
 *  tools+system+messages. We emit at most 2 here; the Anthropic tools
 *  marker brings the total to 3 max. */
export function countCacheBoundaries(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) if (m.cacheBoundary) n++;
  return n;
}
