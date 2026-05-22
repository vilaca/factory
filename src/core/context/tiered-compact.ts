import type { ChatMessage } from '../../utils/chat-message.js';
import { inferDefaultMessageType } from '../../utils/chat-message.js';

/**
 * Tiered, deterministic compaction. Three escalating phases of structured
 * text removal — no LLM call. Each phase drops or shrinks one class of
 * message, leaving the model's interpretive context (reasoning,
 * tool_call skeletons) intact as long as possible.
 *
 * Cut order matches the reliability spec (docs/reliability/next-steps.md §10):
 *   1. Cut first: ephemeral nudges (no long-term value).
 *   2. Cut second: raw tool data (recoverable — model can re-call).
 *   3. Cut third: text response (failed attempt, already corrected).
 *   4. Cut fourth: reasoning (interpretive context — kills decisions if lost).
 *   5. Preserved: tool_call skeletons (cheap, anchor the conversation arc).
 *   6. Never cut: system + first user_input + recent iterations.
 *
 * Why the lossy-but-structured approach over a model-summary call: the
 * 10-step compaction-strategy table in the IEEE preprint (Table III)
 * shows tiered beats sliding-window by 18 points at moderate pressure
 * (P1 trigger) because it preserves the reasoning the model needs to
 * cross-reference earlier findings, while still freeing the budget.
 * Sliding window drops the oldest messages indiscriminately — including
 * the reasoning that later steps depend on.
 */

/** Maximum kept length (in characters) for a tool_result body during
 *  Phase 1. Tail of the message is replaced with a marker. 200 is the
 *  value from the reference framework — small enough to free real
 *  budget on a 5–10K message, large enough to leave the model a hint
 *  about what came back ("file not found", "command exit 0",
 *  "matching/N rows…"). */
export const TRUNCATE_CHARS = 200;

/** Number of *iteration boundaries* (distinct stepIndex values) at the
 *  tail of the conversation that are never modified by tiered
 *  compaction. A boundary is a parallel batch (one TOOL_CALL + N
 *  TOOL_RESULT messages sharing one stepIndex), so keeping 2 means the
 *  last two turns survive in full even at Phase 3. */
export const DEFAULT_KEEP_RECENT = 2;

export type CompactionPhase = 0 | 1 | 2 | 3;

export interface TieredCompactResult {
  /** Highest phase actually applied. Phase 0 = no compaction
   *  performed (already under budget or nothing eligible). */
  phase: CompactionPhase;
  /** Resulting (possibly identical) message list. Callers replace the
   *  conversation's stored messages with this. */
  messages: ChatMessage[];
  /** True when at least one message was cut or rewritten. Lets
   *  observability count meaningful events without re-running a diff. */
  changed: boolean;
}

/** Phase predicate: which message types are dropped/truncated at each tier.
 *  Pulled out for testability — each phase is just a transformation
 *  function over `eligible` messages. */
function isEphemeralNudge(msg: ChatMessage): boolean {
  const type = msg.metadata?.type ?? inferDefaultMessageType(msg);
  return type === 'step_nudge' || type === 'prerequisite_nudge' || type === 'retry_nudge';
}

function isToolResult(msg: ChatMessage): boolean {
  const type = msg.metadata?.type ?? inferDefaultMessageType(msg);
  return type === 'tool_result';
}

function isReasoningOrTextResponse(msg: ChatMessage): boolean {
  const type = msg.metadata?.type ?? inferDefaultMessageType(msg);
  return type === 'reasoning' || type === 'text_response';
}

/** Truncate a tool_result body in place; idempotent. Marker uses the
 *  same `[Truncated — N chars removed]` shape the reliability spec
 *  documents so log scrapers can find compacted results. */
function truncateToolResult(msg: ChatMessage): ChatMessage {
  if (msg.content.length <= TRUNCATE_CHARS) return msg;
  const removed = msg.content.length - TRUNCATE_CHARS;
  return {
    ...msg,
    content: `${msg.content.slice(0, TRUNCATE_CHARS)}\n[Truncated — ${removed} chars removed]`,
  };
}

/**
 * Find the first index in `messages` that belongs to the trailing
 * `keepRecent` iteration boundaries. Everything in `[eligibleStart,
 * eligibleEnd)` is fair game for compaction; the system message and the
 * first user input are at indices < eligibleStart (always preserved),
 * and indices ≥ eligibleEnd are inside the recent window.
 *
 * Boundary detection groups messages by `metadata.stepIndex`. Messages
 * with no `stepIndex` (pre-tagging history) each count as their own
 * boundary — conservative behavior that lets the function still make
 * forward progress when the agent loop hasn't tagged yet. The agent
 * loop will start setting `stepIndex` once Phase 3's tagging spreads
 * through the call sites.
 */
export function findEligibleEnd(messages: ChatMessage[], keepRecent: number): number {
  // [0] = system_prompt — never eligible. [1] is the first user input,
  // which we also keep out of the eligible range as a safety net
  // (matches the spec's "messages[0:2] never cut" rule).
  if (messages.length <= 2) return messages.length;
  const tail = messages.slice(2);

  // Walk from the tail backwards collecting distinct stepIndex slots
  // (or distinct positions when stepIndex is missing). When we've seen
  // `keepRecent` boundaries, the next boundary forward is the cut.
  const seen: Array<number | string> = [];
  let cutTailIndex = tail.length;
  for (let i = tail.length - 1; i >= 0; i--) {
    const msg = tail[i]!;
    const key = msg.metadata?.stepIndex ?? `__nostep_${i}`;
    if (!seen.includes(key)) {
      if (seen.length >= keepRecent) {
        cutTailIndex = i + 1;
        break;
      }
      seen.push(key);
      // Even when this boundary will be the keepRecent-th, we keep
      // walking — the first message of this boundary becomes the
      // floor of the recency window.
      cutTailIndex = i;
    }
  }
  return cutTailIndex + 2;
}

/** Apply Phase 1: drop ephemeral nudges, truncate tool_results to 200
 *  chars. Returns the rewritten message slice and whether anything
 *  changed. */
function applyPhase1(eligible: ChatMessage[]): { out: ChatMessage[]; changed: boolean } {
  let changed = false;
  const out: ChatMessage[] = [];
  for (const msg of eligible) {
    if (isEphemeralNudge(msg)) {
      changed = true;
      continue;
    }
    if (isToolResult(msg) && msg.content.length > TRUNCATE_CHARS) {
      out.push(truncateToolResult(msg));
      changed = true;
      continue;
    }
    out.push(msg);
  }
  return { out, changed };
}

/** Apply Phase 2: Phase 1's drops + drop tool_results entirely. The
 *  tool_call assistant message stays — it anchors the arc and tells
 *  the model "I did call X with these args" so it doesn't redo the
 *  call from scratch. */
function applyPhase2(eligible: ChatMessage[]): { out: ChatMessage[]; changed: boolean } {
  const phase1 = applyPhase1(eligible);
  let changed = phase1.changed;
  const out: ChatMessage[] = [];
  for (const msg of phase1.out) {
    if (isToolResult(msg)) {
      changed = true;
      continue;
    }
    out.push(msg);
  }
  return { out, changed };
}

/** Apply Phase 3: Phase 2's drops + drop reasoning and text_response.
 *  Last resort — only `tool_call` skeletons remain in the eligible
 *  range. Loses the model's interpretive context, but keeps the arc
 *  of "what was tried." */
function applyPhase3(eligible: ChatMessage[]): { out: ChatMessage[]; changed: boolean } {
  const phase2 = applyPhase2(eligible);
  let changed = phase2.changed;
  const out: ChatMessage[] = [];
  for (const msg of phase2.out) {
    if (isReasoningOrTextResponse(msg)) {
      changed = true;
      continue;
    }
    out.push(msg);
  }
  return { out, changed };
}

/**
 * Run tiered compaction. `phaseTriggers[i]` is the *minimum* token
 * fraction at which phase `i+1` becomes legal — the caller passes
 * `currentFraction = currentTokens / budget` so the function knows how
 * deep to escalate. Re-estimation between phases is the caller's job:
 * pass an `estimate(messages)` callback that reports the current
 * fraction after each cut. The function escalates only as far as
 * needed.
 *
 * Returns the highest phase actually applied (or Phase 0 if nothing
 * needed cutting), the new message list, and whether anything
 * changed.
 */
export function runTieredCompact(opts: {
  messages: readonly ChatMessage[];
  estimateFraction: (msgs: ChatMessage[]) => number;
  /** Below this fraction, no further phases run. Default 0.75 —
   *  matches the framework's "compact when over 75% of budget" rule. */
  stopBelow?: number;
  /** Floor below which we don't even start Phase 1. Default same as
   *  `stopBelow`; pass a smaller value to force a Phase 1 pass even
   *  when the budget isn't tight (used by the proactive ageing
   *  variant). */
  triggerAt?: number;
  /** Number of trailing iteration boundaries to preserve in full. */
  keepRecent?: number;
}): TieredCompactResult {
  const stopBelow = opts.stopBelow ?? 0.75;
  const triggerAt = opts.triggerAt ?? stopBelow;
  const keepRecent = opts.keepRecent ?? DEFAULT_KEEP_RECENT;

  const originalArr = [...opts.messages];
  const currentFraction = opts.estimateFraction(originalArr);
  if (currentFraction < triggerAt) {
    return { phase: 0, messages: originalArr, changed: false };
  }
  if (originalArr.length <= 2) {
    return { phase: 0, messages: originalArr, changed: false };
  }

  const eligibleEnd = findEligibleEnd(originalArr, keepRecent);
  const head = originalArr.slice(0, 2);
  const tailKept = originalArr.slice(eligibleEnd);
  const eligible = originalArr.slice(2, eligibleEnd);
  if (eligible.length === 0) {
    return { phase: 0, messages: originalArr, changed: false };
  }

  // Phase 1
  const p1 = applyPhase1(eligible);
  let workingMessages = [...head, ...p1.out, ...tailKept];
  let phaseReached: CompactionPhase = p1.changed ? 1 : 0;
  let cumulativeChanged = p1.changed;
  if (opts.estimateFraction(workingMessages) < stopBelow) {
    return { phase: phaseReached, messages: workingMessages, changed: cumulativeChanged };
  }

  // Phase 2 (supersets P1 internally — see applyPhase2). `changed` reflects
  // the phase's own delta vs. its input; we OR with the running flag so the
  // returned `changed` is the cumulative result vs. the original eligible
  // slice, not just the final phase's delta.
  const p2 = applyPhase2(eligible);
  workingMessages = [...head, ...p2.out, ...tailKept];
  phaseReached = p2.changed ? 2 : phaseReached;
  cumulativeChanged = cumulativeChanged || p2.changed;
  if (opts.estimateFraction(workingMessages) < stopBelow) {
    return { phase: phaseReached, messages: workingMessages, changed: cumulativeChanged };
  }

  // Phase 3
  const p3 = applyPhase3(eligible);
  workingMessages = [...head, ...p3.out, ...tailKept];
  phaseReached = p3.changed ? 3 : phaseReached;
  cumulativeChanged = cumulativeChanged || p3.changed;
  return { phase: phaseReached, messages: workingMessages, changed: cumulativeChanged };
}
