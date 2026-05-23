import type { ToolCallMessage } from '../../providers/types.js';
import type { Nudge } from './nudges.js';
import { retryNudge, unknownToolNudge } from './nudges.js';

/**
 * Stateless response validator. Decides whether the model's output for
 * a turn is executable as-is, or whether the agent loop should inject a
 * nudge and retry.
 *
 * The validator does NOT own the retry budget — that lives in the
 * caller (RecoveryState today, the ErrorTracker once Phase 6 lands).
 * Keeping the validator stateless means it can be unit-tested in
 * isolation and reused by alternate loops (Phase 15's `runInference`
 * extraction, future BFCL-style harnesses) without inheriting the
 * counter semantics.
 *
 * Per docs/reliability/next-steps.md §4:
 *   - Input: `LLMResponse` (tool calls + text content + any rescued
 *     tool calls from text parsing).
 *   - Output: `ValidationResult` carrying either tool calls (execute)
 *     or a nudge (retry).
 *
 * Rescue parsing is *not* performed here — Phase 4's design keeps the
 * existing `parseModelResponse` as the lower-level parser (it
 * already implements the three rescue strategies the spec describes
 * in §5). The validator runs *after* rescue; its job is to decide
 * "do we have anything executable or do we nudge?"
 */

export interface ValidationResult {
  /** Tool calls to execute. When set, `nudge` is omitted and
   *  `needsRetry` is false. */
  toolCalls?: ToolCallMessage[];
  /** Corrective message to inject into history before the next call.
   *  Mutually exclusive with `toolCalls`. */
  nudge?: Nudge;
  /** True when the loop should re-call the model after injecting the
   *  nudge, false when the validator wants the turn to complete (e.g.
   *  a plain text answer in non-respond-enforcement mode). */
  needsRetry: boolean;
}

export interface ValidatorContext {
  /** Names of every tool the model could legally call this turn. The
   *  validator uses this for the unknown-tool check. */
  toolNames: ReadonlySet<string>;
  /** When true, a text-only response with no recovered tool calls is
   *  treated as a malformed turn and triggers a retry nudge — used by
   *  the small-model reliability path (Phase 1's `useRespondTool` set
   *  via auto-enable). When false (frontier models, default), a
   *  text-only turn is the natural turn-complete. */
  enforceToolCall: boolean;
}

/**
 * Validate a parsed model response.
 *
 * Inputs are the agent loop's view of the response *after* rescue:
 *   - `toolCalls`        — what the model emitted (or what rescue salvaged)
 *   - `textContent`      — the assistant's text (possibly empty)
 *
 * Cases the validator handles:
 *   1. Empty tool calls + non-empty text + `enforceToolCall` → retry nudge
 *   2. Tool calls reference an unknown name → unknown_tool nudge
 *   3. Anything else                       → execute as-is
 *
 * The validator returns the *first* unknown-tool name it encounters
 * rather than the whole set — listing them all would make the nudge
 * conversational rather than directive. The spec found that telling
 * the model exactly one wrong name was more corrective.
 */
export function validateResponse(
  toolCalls: ToolCallMessage[],
  textContent: string,
  ctx: ValidatorContext,
): ValidationResult {
  // Unknown tool check runs first — if the model named a non-existent
  // tool, that's a clearer corrective signal than "your text response
  // wasn't a tool call." Pick the first unknown name; subsequent calls
  // become irrelevant once the model retries with a valid one.
  // Case-insensitive — models routinely lowercase ("read" instead of
  // "Read"); the registry's `get` already does case-insensitive lookup
  // so the call would succeed at runtime, but the validator's set
  // membership check needs to match.
  const lowerNames = new Set<string>();
  for (const n of ctx.toolNames) lowerNames.add(n.toLowerCase());
  for (const tc of toolCalls) {
    const name = tc.function?.name;
    if (!name) continue;
    if (ctx.toolNames.has(name)) continue;
    if (lowerNames.has(name.toLowerCase())) continue;
    return {
      needsRetry: true,
      nudge: unknownToolNudge(name, [...ctx.toolNames]),
    };
  }

  if (toolCalls.length > 0) {
    return { needsRetry: false, toolCalls };
  }

  // No tool calls. Behavior diverges by mode:
  if (ctx.enforceToolCall && textContent.trim().length > 0) {
    return { needsRetry: true, nudge: retryNudge() };
  }
  // Empty content with no tool calls — caller decides (the agent loop
  // already handles this via the auto-retry-injected path when a prior
  // tool error left a `lastFailureMessage` set). We don't fabricate a
  // nudge from here.
  return { needsRetry: false };
}
