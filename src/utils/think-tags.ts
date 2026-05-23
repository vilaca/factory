/**
 * Pure-text helpers for the two non-server inline-reasoning formats
 * (`docs/reliability/next-steps.md` §15). Kept in `utils/` so both
 * provider adapters and the core agent layer can call them without
 * crossing the providers→core architectural boundary.
 */

// Matches either [THINK]...[/THINK] or <think>...</think>. Two capture
// groups so callers can tell which dialect produced the match (currently
// unused — both flow through the same handling, but distinct for future
// per-format tuning).
const THINK_RE = /(?:\[THINK\]([\s\S]*?)\[\/THINK\]|<think>([\s\S]*?)<\/think>)/g;

export interface ThinkExtractResult {
  /** All reasoning blocks joined with double newline. Empty string
   *  when no tags were found. */
  reasoning: string;
  /** Original content with every recognized think block removed. */
  remaining: string;
}

/**
 * Split content into reasoning text + remaining content. Recognizes
 * the two non-server formats — Mistral `[THINK]...[/THINK]` and
 * Qwen/DeepSeek `<think>...</think>` — and strips both. The result's
 * `remaining` is trimmed of excess blank lines left behind.
 *
 * Returns `reasoning: ''` and the input unchanged when no tags are
 * found, so callers can use this unconditionally without a pre-check.
 */
export function extractThinkTags(content: string): ThinkExtractResult {
  if (!content) return { reasoning: '', remaining: content };
  const blocks: string[] = [];
  let saw = false;
  const remaining = content.replace(THINK_RE, (_match, a: string | undefined, b: string | undefined) => {
    saw = true;
    const text = (a ?? b ?? '').trim();
    if (text) blocks.push(text);
    return '';
  });
  if (!saw) return { reasoning: '', remaining: content };
  return {
    reasoning: blocks.join('\n\n'),
    remaining: remaining.replace(/\n{3,}/g, '\n\n').trim(),
  };
}

/**
 * Strip inline think tags from streamed content when the caller asked
 * not to see thinking (`thinking: false` per next-steps.md §15). Used
 * by provider adapters that can't fully suppress the model's `<think>`
 * emission server-side — Qwen3 on certain serving stacks leaks the
 * tags even when the request says `think=false`.
 *
 * Returns the cleaned content; the extracted reasoning is dropped
 * intentionally. When the caller wants the reasoning surfaced, use
 * `extractThinkTags` directly.
 */
export function discardThinkTags(content: string): string {
  if (!content) return content;
  return extractThinkTags(content).remaining;
}
