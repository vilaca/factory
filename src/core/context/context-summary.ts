import type { ChatMessage, Provider } from '../../providers/types.js';
import { estimateMessagesTokens } from '../../utils/tokens.js';
import { isError } from '../../utils/errors.js';

const LATEST_USER_MAX_CHARS = 500;
const LATEST_ASSISTANT_MAX_CHARS = 300;
const SUMMARY_PREFIX = '[Previous conversation summary]\n';
const AUTO_RETRY_PREFIX = 'Your last tool call failed with:';

/** Token reservations for the summary call's own framing — see
 *  `buildModelSummary`: a system instruction (~30 tokens) and a closing
 *  user prompt (~30 tokens), plus margin. Subtracted from the context
 *  window when deciding whether `toSummarize` fits. */
const SUMMARY_FRAMING_TOKENS = 100;
/** Output tokens reserved for the summary itself — matches `maxTokens`
 *  passed to `provider.chatNoStream` in `buildModelSummary`. */
const SUMMARY_OUTPUT_RESERVE = 512;
/** Safety multiplier applied to the budget after framing/output are
 *  subtracted. The heuristic estimate can undercount by ~10–15% on
 *  tokenizer mismatch, so leaving this margin keeps a near-budget slice
 *  from overflowing the provider limit. */
const SUMMARY_BUDGET_SAFETY = 0.85;

interface SummaryToolCall {
  function: {
    name: string;
    arguments?: Record<string, unknown>;
  };
}
export type SummaryMessage = { role: string; content: string; tool_calls?: SummaryToolCall[] };

/** Largest message slice (in estimated tokens) that fits in a single
 *  summary call against `contextWindow`. Returns 0 when there isn't
 *  enough headroom for framing + reserved output — caller should skip
 *  the LLM path entirely and use the mechanical summary. */
function computeSummarizeBudget(contextWindow: number): number {
  return Math.max(
    0,
    Math.floor(
      (contextWindow - SUMMARY_FRAMING_TOKENS - SUMMARY_OUTPUT_RESERVE) * SUMMARY_BUDGET_SAFETY,
    ),
  );
}

/** True iff `toSummarize` is too large to feed through a single model
 *  summary call given the current context window. */
export function shouldSkipLlmSummary(toSummarize: ChatMessage[], contextWindow: number): boolean {
  const budget = computeSummarizeBudget(contextWindow);
  if (budget <= 0) return true;
  return estimateMessagesTokens(toSummarize) > budget;
}

/** Ask the model to produce a freeform summary of `toSummarize`. Returns
 *  null on any non-abort failure (caller falls back to mechanical).
 *  Re-throws aborts so the agent loop handles them as user-abort. */
export async function buildModelSummary(
  provider: Provider,
  model: string,
  toSummarize: ChatMessage[],
  signal?: AbortSignal,
): Promise<string | null> {
  const summaryPrompt: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Summarize the key context from this conversation. Include: files accessed, tools used, decisions made, and current task state. Be concise.',
    },
    ...toSummarize,
    {
      role: 'user',
      content:
        'Provide a concise summary of the conversation above, focusing on context needed to continue the work.',
    },
  ];
  try {
    const response = await provider.chatNoStream(model, summaryPrompt, undefined, {
      maxTokens: SUMMARY_OUTPUT_RESERVE,
      signal,
      _requestSource: 'compaction',
    });
    return response.content ?? null;
  } catch (err: unknown) {
    if (signal?.aborted || (isError(err) && err.name === 'AbortError')) throw err;
    return null;
  }
}

/** Deterministic, model-free summary used as a fallback when the LLM
 *  summary call fails or the slice is too large to fit a single call.
 *  Extracts tools used, files accessed, the latest user request, and the
 *  latest assistant reply; carries any prior `[Previous conversation
 *  summary]` text forward so cascaded compactions don't drop it. */
export function buildMechanicalSummary(messages: SummaryMessage[]): string {
  const toolsUsed = new Set<string>();
  const filesAccessed = new Set<string>();
  const priorSummaries: string[] = [];

  for (const msg of messages) {
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolsUsed.add(tc.function.name);
        const args = tc.function.arguments;
        if (args?.file_path) filesAccessed.add(String(args.file_path));
        if (args?.path) filesAccessed.add(String(args.path));
      }
    }
    if (
      msg.role === 'user' &&
      typeof msg.content === 'string' &&
      msg.content.startsWith(SUMMARY_PREFIX)
    ) {
      priorSummaries.push(msg.content.slice(SUMMARY_PREFIX.length));
    }
  }

  const latestUser = findLatestUserRequest(messages);
  const latestAssistant = findLatestAssistantContent(messages);

  const lines = [`Conversation summary (${messages.length} messages compacted):`];
  if (priorSummaries.length > 0) {
    lines.push(...priorSummaries);
  }
  if (latestUser) {
    lines.push(`Latest user request: ${truncate(latestUser, LATEST_USER_MAX_CHARS)}`);
  }
  if (latestAssistant) {
    lines.push(`Latest assistant reply: ${truncate(latestAssistant, LATEST_ASSISTANT_MAX_CHARS)}`);
  }
  if (toolsUsed.size > 0) {
    lines.push(`Tools used: ${[...toolsUsed].join(', ')}`);
  }
  if (filesAccessed.size > 0) {
    lines.push(`Files accessed: ${[...filesAccessed].slice(0, 20).join(', ')}`);
  }
  return lines.join('\n');
}

function findLatestUserRequest(messages: SummaryMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    const content = msg.content.trim();
    if (!content) continue;
    if (content.startsWith(SUMMARY_PREFIX.trim())) continue;
    if (content.startsWith(AUTO_RETRY_PREFIX)) continue;
    return content;
  }
  return null;
}

function findLatestAssistantContent(messages: SummaryMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant' || typeof msg.content !== 'string') continue;
    const content = msg.content.trim();
    if (!content) continue;
    return content;
  }
  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)} …`;
}

/** Threshold-warning text. Wording escalates with the threshold: the
 *  65% message is a gentle "we're filling up, be concise"; the 80%
 *  message is more directive ("summarize critical findings now").
 *  Verbatim from the reliability spec (§11). Falls back to a generic
 *  message for any non-standard threshold consumers configure. */
export function defaultWarningTemplate(threshold: number): string {
  if (threshold >= 0.8) {
    return 'Context is nearly full. Older tool results and reasoning will be compacted soon — key information may be lost. Summarize critical findings now and prioritize completing the current task.';
  }
  if (threshold >= 0.65) {
    return 'Context is filling up. When compaction triggers, older tool results and reasoning will be condensed. Be concise in your responses and front-load important information.';
  }
  return `Context usage has crossed ${Math.round(threshold * 100)}%. Be concise.`;
}
