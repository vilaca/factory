// Typed selectors over TokenUsage.
//
// Background: 44aeb26 fixed a status-bar bug where the "context
// fullness" denominator was fed `totalTokens` (= prompt + completion).
// The figure jittered downward every time the model gave a long reply,
// because completion tokens fold into the *next* prompt as a small
// assistant message — not the full verbatim completion. The right
// metric is `promptTokens`: "how full is my next prompt right now."
//
// The fix patched one call site. Nothing stopped a future consumer
// from doing the same plucking-by-field-name mistake. This module
// owns the semantic mapping from TokenUsage to specific
// interpretations, so consumers never write `usage.totalTokens` or
// `usage.promptTokens` directly when what they actually mean is "the
// context-fullness figure for the status bar."
//
// An arch test (test/unit/arch/modularity.test.ts) forbids
// status-bar.tsx from importing TokenUsage fields directly — it must
// route through this module.

/** Structural minimum needed by `contextFillTokens`. Accepts the full
 *  `TokenUsage` from providers as well as React-state snapshots that
 *  only carry the relevant field — callers shouldn't have to widen
 *  their type to import this helper. */
export interface PromptTokensCarrier {
  promptTokens?: number;
}

/** "How full is my next prompt?" — the right value to use as the
 *  numerator of a context-window utilisation gauge.
 *
 *  Returns the model-reported `promptTokens` when available. Returns
 *  `undefined` when usage is missing, undefined, or zero-valued (no
 *  model response has landed yet for this conversation) — callers
 *  typically fall back to a local estimate in that case.
 *
 *  Specifically NOT `totalTokens`: that's prompt + completion, and
 *  completion tokens fold into the next prompt as a (usually small)
 *  assistant message rather than appearing verbatim. Using totalTokens
 *  makes the gauge jitter every turn (see 44aeb26). */
export function contextFillTokens(
  usage: PromptTokensCarrier | undefined,
): number | undefined {
  if (!usage) return undefined;
  if (usage.promptTokens === undefined) return undefined;
  if (usage.promptTokens === 0) return undefined;
  return usage.promptTokens;
}
