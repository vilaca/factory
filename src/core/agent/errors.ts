/**
 * Framework-side error hierarchy for the reliability stack. These are
 * thrown by the agent loop's internal phases (step enforcement,
 * prerequisite checking, response validation, tool execution) when a
 * counter exhausts. Each subclass communicates *what kind of
 * exhaustion* occurred so callers can decide whether to bail, prompt
 * the user, rotate model, etc.
 *
 * Deliberately *not* `ToolResolutionError`'s ancestor — that exception
 * lives at `src/tools/errors.ts` and inherits from `Error` directly
 * because it's a tool-author signal, not a framework failure
 * (docs/reliability/next-steps.md §9).
 */
export class ReliabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReliabilityError';
  }
}

/** Raised when the model attempted to call the terminal tool before
 *  required steps were satisfied, *and* the three-tier nudge
 *  escalation didn't recover the workflow. Carries the pending step
 *  list so the caller can surface it. */
export class StepEnforcementError extends ReliabilityError {
  readonly attemptedTerminal: string;
  readonly pending: readonly string[];
  constructor(attemptedTerminal: string, pending: readonly string[]) {
    super(
      `StepEnforcementError: model attempted terminal '${attemptedTerminal}' before completing required steps: ${pending.join(', ')}`,
    );
    this.name = 'StepEnforcementError';
    this.attemptedTerminal = attemptedTerminal;
    this.pending = pending;
  }
}

/** Raised when a tool's prerequisites were violated more times in a
 *  row than the configured budget (default 2). Carries the offending
 *  tool name and missing prereqs. */
export class PrerequisiteError extends ReliabilityError {
  readonly attemptedTool: string;
  readonly missing: readonly string[];
  constructor(attemptedTool: string, missing: readonly string[]) {
    super(
      `PrerequisiteError: prerequisites for '${attemptedTool}' violated repeatedly: missing ${missing.join(', ')}`,
    );
    this.name = 'PrerequisiteError';
    this.attemptedTool = attemptedTool;
    this.missing = missing;
  }
}

/** Raised when consecutive *hard* tool exceptions exceed
 *  `maxHardToolErrors`. Hard = the tool threw something that wasn't a
 *  `ToolResolutionError`; the soft 4xx-style failure doesn't bump
 *  this counter (see `src/tools/errors.ts`). Carries the offending
 *  tool name and the most recent error message. */
export class ToolExecutionError extends ReliabilityError {
  readonly toolName: string;
  readonly lastMessage: string;
  constructor(toolName: string, lastMessage: string) {
    super(
      `ToolExecutionError: tool '${toolName}' raised repeatedly; last error: ${lastMessage}`,
    );
    this.name = 'ToolExecutionError';
    this.toolName = toolName;
    this.lastMessage = lastMessage;
  }
}
