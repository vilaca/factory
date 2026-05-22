/**
 * Think-tag extraction and reasoning-fold utilities (next-steps.md §14, §15).
 *
 * Three thinking-tag formats are in the wild:
 *   - `[THINK]...[/THINK]` — Mistral Ministral Reasoning
 *   - `<think>...</think>` — Qwen3, DeepSeek
 *   - Provider-native `reasoning_content` field — llama-server with
 *     `--reasoning-format auto` (handled per-provider in their adapters)
 *
 * The reliability spec wants reasoning kept as a separate REASONING
 * message in-process so tiered compaction (Phase 3) can drop it
 * independently from the surrounding tool_call. But on the wire,
 * provider Jinja templates expect one assistant message per turn with
 * both `content` (reasoning) and `tool_calls`. The `foldAndSerialize`
 * function below collapses adjacent REASONING + TOOL_CALL messages
 * back into one for the wire — leaves the internal list intact.
 *
 * Factory-code's existing assistant-message shape already bundles
 * content + tool_calls in one message, so the fold step is only
 * relevant when a future refactor starts storing reasoning separately.
 * The utilities here are built and tested now so that refactor doesn't
 * have to invent the parsing rules.
 */
import type { ChatMessage } from './../../utils/chat-message.js';

// Combined pattern: matches either [THINK]...[/THINK] or
// <think>...</think>. Two capture groups so the caller can tell which
// dialect produced the match (currently unused — both flow through
// the same handling, but kept distinct for future per-format tuning).
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
 * Wire-boundary serialization helper: fold orphan `reasoning`-tagged
 * assistant messages into the immediately-following `tool_call`
 * assistant message's `content` field. Used at the moment we hand the
 * conversation off to a provider — keeping reasoning separate
 * in-process for compaction, but bundled on the wire to satisfy Jinja
 * template parity checks on llama-server / other strict backends.
 *
 * The fold rule (from next-steps.md §14):
 *   - When a REASONING message immediately precedes a message with
 *     `tool_calls`, set the following message's `content` to the
 *     reasoning text and drop the orphan.
 *   - When a REASONING message is trailing (no tool_call follows),
 *     emit it as a standalone assistant message.
 *
 * Strips the `metadata` field at this boundary too, so providers
 * never see in-process tags. Callers can use this regardless of
 * whether reasoning is actually stored separately — when no REASONING
 * messages are present, the output is identical to the input minus
 * metadata.
 */
export function foldAndSerialize(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let pendingReasoning: string | null = null;

  for (const m of messages) {
    const type = m.metadata?.type;
    if (type === 'reasoning' && m.role === 'assistant') {
      pendingReasoning = m.content;
      continue;
    }
    const stripped = stripMetadataLocal(m);
    if (pendingReasoning !== null && stripped.tool_calls && stripped.tool_calls.length > 0) {
      out.push({ ...stripped, content: pendingReasoning });
      pendingReasoning = null;
      continue;
    }
    if (pendingReasoning !== null) {
      // Trailing reasoning with no following tool_call — emit as a
      // standalone assistant text turn so it isn't lost on the wire.
      out.push({ role: 'assistant', content: pendingReasoning });
      pendingReasoning = null;
    }
    out.push(stripped);
  }
  if (pendingReasoning !== null) {
    out.push({ role: 'assistant', content: pendingReasoning });
  }
  return out;
}

function stripMetadataLocal(msg: ChatMessage): ChatMessage {
  if (!msg.metadata) return msg;
  const { metadata: _omit, ...rest } = msg;
  return rest;
}
