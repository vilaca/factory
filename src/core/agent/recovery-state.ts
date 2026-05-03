/**
 * Cross-turn failure tracking for the agent loop:
 *  - auto-retry budget after the model bails on tool failure
 *  - consecutive-same-failure halt
 *  - per-signature corrector dedup
 *
 * Per-tool-call state (`lastFailedResult`) stays local to the tool-call loop;
 * only state that needs to outlive a single tool call lives here.
 */
export class RecoveryState {
  autoRetryBudget: number;
  lastFailureMessage: string | null = null;
  lastFailureSignature: string | null = null;
  consecutiveSameFailures = 0;
  correctionsUsedThisRun = 0;
  readonly correctedSignatures = new Set<string>();
  readonly maxCorrections: number;

  constructor(autoRetryBudget: number, maxCorrections: number) {
    this.autoRetryBudget = autoRetryBudget;
    this.maxCorrections = maxCorrections;
  }
}
