/**
 * Cross-turn failure tracking for the agent loop. The reliability spec
 * (§9) splits "failure" into three counter classes:
 *
 *  - `autoRetryBudget` (formatting / text-only / unknown tool) —
 *    bounded by `maxRetries` (default 3). Reset when the model
 *    emits a valid tool call.
 *  - `consecutiveHardToolErrors` (the tool's callable threw an
 *    exception that wasn't a `ToolResolutionError`) — bounded by
 *    `maxHardToolErrors` (default 2). Reset on any clean batch.
 *  - `consecutivePremature` / `consecutivePrereq` — owned by
 *    `StepEnforcer`; not duplicated here.
 *
 * The hard-vs-soft distinction (§9) is what lets the model fumble
 * through 8+ wrong-key lookups within the iteration budget without
 * tripping the hard-error bail. A `ToolResolutionError` returned as
 * `{ softError: true }` does NOT increment `consecutiveHardToolErrors`.
 *
 * Per-tool-call state (`lastFailedResult`) stays local to the tool-call
 * loop; only state that needs to outlive a single tool call lives here.
 */
export class RecoveryState {
  autoRetryBudget: number;
  lastFailureMessage: string | null = null;
  lastFailureSignature: string | null = null;
  consecutiveSameFailures = 0;
  correctionsUsedThisRun = 0;
  readonly correctedSignatures = new Set<string>();
  readonly maxCorrections: number;

  /** Hard-exception counter for tools (5xx-equivalent). Increments on
   *  any non-ToolResolutionError throw from a tool callable; resets
   *  on any clean batch. Bounded by `maxHardToolErrors`. */
  consecutiveHardToolErrors = 0;
  /** Last hard-error message and tool name — used to construct
   *  ToolExecutionError when the counter exhausts. */
  lastHardToolName: string | null = null;
  lastHardToolMessage: string | null = null;
  readonly maxHardToolErrors: number;

  constructor(autoRetryBudget: number, maxCorrections: number, maxHardToolErrors = 2) {
    this.autoRetryBudget = autoRetryBudget;
    this.maxCorrections = maxCorrections;
    this.maxHardToolErrors = maxHardToolErrors;
  }

  /** Shallow snapshot for parallel Delegate batches: each pipeline gets
   *  its own RecoveryState so applyResultToRecovery / runCorrectorIfNeeded
   *  don't fight over the same fields under interleaved execution. The
   *  clone shares no mutable references with the source — `correctedSignatures`
   *  is a fresh Set seeded from the parent's entries. */
  clone(): RecoveryState {
    const out = new RecoveryState(
      this.autoRetryBudget,
      this.maxCorrections,
      this.maxHardToolErrors,
    );
    out.lastFailureMessage = this.lastFailureMessage;
    out.lastFailureSignature = this.lastFailureSignature;
    out.consecutiveSameFailures = this.consecutiveSameFailures;
    out.correctionsUsedThisRun = this.correctionsUsedThisRun;
    for (const s of this.correctedSignatures) out.correctedSignatures.add(s);
    out.consecutiveHardToolErrors = this.consecutiveHardToolErrors;
    out.lastHardToolName = this.lastHardToolName;
    out.lastHardToolMessage = this.lastHardToolMessage;
    return out;
  }
}

/** Merge per-pipeline RecoveryState clones from a parallel batch back
 *  into the shared one. The merge is deterministic and worst-case:
 *
 *  - Hard-error counter, consecutive-same-failures: max across siblings
 *    (a single misbehaving pipeline shouldn't get amnestied by a
 *    parallel sibling's success).
 *  - last* fields: take from the first sibling that recorded a failure
 *    so the surfaced "what went wrong" stays stable in batch order.
 *    Cleared if every sibling ended clean.
 *  - correctionsUsedThisRun: sum of deltas (each pipeline burns from
 *    the shared budget; under parallel execution we count them all).
 *  - correctedSignatures: union (a signature corrected once anywhere
 *    in the batch should be considered "tried" by everyone).
 *
 *  Caller is expected to pass `clones` in deterministic batch order. */
export function mergeRecoveryClones(parent: RecoveryState, clones: readonly RecoveryState[]): void {
  if (clones.length === 0) return;
  const parentCorrectionsBefore = parent.correctionsUsedThisRun;
  let firstFailure: RecoveryState | null = null;
  let maxHard = 0;
  let maxSame = 0;
  let extraCorrections = 0;
  for (const c of clones) {
    if (c.lastFailureMessage && firstFailure === null) firstFailure = c;
    if (c.consecutiveHardToolErrors > maxHard) maxHard = c.consecutiveHardToolErrors;
    if (c.consecutiveSameFailures > maxSame) maxSame = c.consecutiveSameFailures;
    extraCorrections += Math.max(0, c.correctionsUsedThisRun - parentCorrectionsBefore);
    for (const s of c.correctedSignatures) parent.correctedSignatures.add(s);
  }
  parent.consecutiveHardToolErrors = maxHard;
  parent.consecutiveSameFailures = maxSame;
  parent.correctionsUsedThisRun = parentCorrectionsBefore + extraCorrections;
  if (firstFailure) {
    parent.lastFailureMessage = firstFailure.lastFailureMessage;
    parent.lastFailureSignature = firstFailure.lastFailureSignature;
    parent.lastHardToolName = firstFailure.lastHardToolName;
    parent.lastHardToolMessage = firstFailure.lastHardToolMessage;
  } else {
    parent.lastFailureMessage = null;
    parent.lastFailureSignature = null;
    parent.lastHardToolName = null;
    parent.lastHardToolMessage = null;
  }
}
