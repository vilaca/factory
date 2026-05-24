import type { ToolCallMessage } from '../../providers/types.js';
import type { AgentEvent, AgentOptions } from './types.js';
import type { TurnExit } from './phase-types.js';
import type { RecoveryState } from './recovery-state.js';
import type { StepEnforcer } from './step-enforcer.js';
import { ToolExecutionError } from './errors.js';

export interface PostExecutionInput {
  toolCalls: ToolCallMessage[];
  deniedCount: number;
  recovery: RecoveryState;
  stepEnforcer: StepEnforcer | undefined;
  planMode: boolean;
  /** Per-run set tracking which `step-completed` events have already
   *  been surfaced, so a counter reset doesn't re-emit them. Mutated by
   *  this phase via `settleCleanBatch`. */
  emittedStepCompletions: Set<string>;
}

/** Phase G: post-tool-execution termination checks + step-completion
 *  emission.
 *
 *  Returns:
 *  - `null` ⇒ no termination condition; loop continues to next iteration.
 *  - `TurnExit` ⇒ one of three controlled exits:
 *    - `error`     — consecutive-hard-error budget exhausted (carries a
 *      `ToolExecutionError` with the last tool name + message).
 *    - `completed` — all calls in the batch were denied (and not in
 *      plan mode), so the user is rejecting the direction.
 *    - `completed` — two consecutive batches with the same failure
 *      signature; the tool is stuck in a loop.
 *
 *  Mutation surface: `recovery` is read-only here (it was mutated by
 *  `runToolCalls` upstream). `emittedStepCompletions` is mutated by
 *  `settleCleanBatch`. */
export async function* runPostExecution(
  options: AgentOptions,
  input: PostExecutionInput,
): AsyncGenerator<AgentEvent, TurnExit | null> {
  const { toolCalls, deniedCount, recovery, stepEnforcer, planMode, emittedStepCompletions } =
    input;

  if (stepEnforcer && deniedCount === 0 && !recovery.lastFailureMessage) {
    yield* settleCleanBatch(stepEnforcer, options.requiredSteps, emittedStepCompletions);
  }

  // Phase 6: hard-error bailout — over the consecutive-throws budget.
  if (isHardErrorBudgetExhausted(recovery)) {
    const err = new ToolExecutionError(recovery.lastHardToolName!, recovery.lastHardToolMessage!);
    return { kind: 'done', stopReason: 'error', error: err };
  }

  // All tool calls in this turn were denied. The user is rejecting the
  // direction; don't keep prompting the model — halt and let them speak.
  if (!planMode && toolCalls.length > 0 && deniedCount === toolCalls.length) {
    yield { type: 'all-denied-halt', count: deniedCount };
    return { kind: 'done', stopReason: 'completed' };
  }

  if (recovery.consecutiveSameFailures >= 2 && recovery.lastFailureMessage) {
    yield { type: 'auto-retry-exhausted' };
    return { kind: 'done', stopReason: 'completed' };
  }

  return null;
}

/** Phase 5 clean-batch reset + step-completion emission. Called when
 *  the batch ran without denials or tool failures: resets the step
 *  enforcer's per-batch counters and yields one `step-completed` event
 *  per required-step name that's newly satisfied. The
 *  `emittedStepCompletions` set tracks which names we've already
 *  surfaced so a counter reset later in the run doesn't re-emit them. */
async function* settleCleanBatch(
  stepEnforcer: StepEnforcer,
  requiredSteps: readonly string[] | undefined,
  emittedStepCompletions: Set<string>,
): AsyncGenerator<AgentEvent> {
  stepEnforcer.resetCounters();
  const pending = new Set(stepEnforcer.pending());
  for (const name of requiredSteps ?? []) {
    if (!pending.has(name) && !emittedStepCompletions.has(name)) {
      emittedStepCompletions.add(name);
      yield { type: 'step-completed', tool: name };
    }
  }
}

/** True when the consecutive-hard-error budget is exhausted AND we have
 *  a recorded tool name + message to raise with. Both conditions matter
 *  — a counter trip without a recorded tool would only happen on a
 *  logic bug, but we tolerate it by falling through. */
function isHardErrorBudgetExhausted(recovery: RecoveryState): boolean {
  return (
    recovery.consecutiveHardToolErrors > recovery.maxHardToolErrors &&
    recovery.lastHardToolName !== null &&
    recovery.lastHardToolMessage !== null
  );
}
