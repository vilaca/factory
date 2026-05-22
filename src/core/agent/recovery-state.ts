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
}
