import type { ToolCallMessage } from '../../providers/types.js';
import type { AgentEvent, AgentOptions } from './types.js';
import type { StepEnforcer } from './step-enforcer.js';
import { StepEnforcementError, PrerequisiteError } from './errors.js';

export interface EnforcementInput {
  toolCalls: ToolCallMessage[];
  stepEnforcer: StepEnforcer;
}

/** Three-way outcome of the per-batch enforcement check:
 *  - `pass`     ⇒ no nudge, no error — proceed to tool execution.
 *  - `continue` ⇒ a nudge was injected into conversation history; the
 *    loop must re-iterate so the model sees it on the next turn.
 *  - `done`     ⇒ the enforcer threw a typed escalation
 *    (`StepEnforcementError` / `PrerequisiteError`); finalize as
 *    `error`. Other (unexpected) exceptions propagate to the outer
 *    try/catch in `runAgent`, per the `TurnOutcome` contract. */
export type EnforcementResult =
  | { kind: 'pass' }
  | { kind: 'continue' }
  | { kind: 'done'; stopReason: 'error'; error: Error };

/** Phase 5 enforcement: run BEFORE tool execution so a premature
 *  terminal or unmet prereq becomes a nudge rather than a wasted tool
 *  call. The model's attempted tool_call is already in conversation
 *  history (`addAssistant` happened in the response-emission phase) —
 *  emitting the corrective user-role nudge alongside it is exactly the
 *  "skeleton + nudge" shape the reliability spec prescribes (§7).
 *
 *  Caller wraps in `if (options.stepEnforcer)` so the phase contract
 *  only ever sees a defined enforcer. */
export async function* runEnforcement(
  options: AgentOptions,
  input: EnforcementInput,
): AsyncGenerator<AgentEvent, EnforcementResult> {
  const { toolCalls, stepEnforcer } = input;
  const conversation = options.conversation;

  try {
    // Compute the nudge content BEFORE yielding observability —
    // checkPrerequisites/check mutate counters, so calling them inside
    // a predicate and again in the emitter would double-count.
    const prereqCheck = stepEnforcer.checkPrerequisites(toolCalls);
    if (prereqCheck.nudge) {
      conversation.addUser(prereqCheck.nudge.content, { type: 'prerequisite_nudge' });
    }
    const stepCheck = !prereqCheck.nudge ? stepEnforcer.check(toolCalls) : null;
    if (stepCheck?.nudge) {
      conversation.addUser(stepCheck.nudge.content, { type: 'step_nudge' });
    }
    const which = yield* emitEnforcerObservability(
      toolCalls,
      prereqCheck,
      stepCheck,
      options.terminalTools,
      stepEnforcer,
    );
    if (which !== null) return { kind: 'continue' };
    return { kind: 'pass' };
  } catch (err: unknown) {
    if (err instanceof StepEnforcementError || err instanceof PrerequisiteError) {
      return { kind: 'done', stopReason: 'error', error: err };
    }
    throw err;
  }
}

/** Emit the matching observability event (prereq / step) when the
 *  StepEnforcer's pre-computed checks fired. Returns which kind fired
 *  (or null) so the caller knows whether to `continue` the loop. Pure
 *  side-effect on events — does NOT re-invoke the enforcer (the phase
 *  body already did so once to avoid double-counting the per-batch
 *  violation budget). */
async function* emitEnforcerObservability(
  toolCalls: ToolCallMessage[],
  prereqCheck: { nudge?: { meta?: { attemptedTool?: string; missing?: readonly string[] } } },
  stepCheck: { nudge?: { tier: 1 | 2 | 3 } } | null,
  terminalTools: readonly string[] | undefined,
  enforcer: StepEnforcer,
): AsyncGenerator<AgentEvent, 'prereq' | 'step' | null> {
  if (prereqCheck.nudge) {
    const meta = prereqCheck.nudge.meta;
    const fallbackOffender = toolCalls.find(tc => tc.function?.name !== undefined);
    yield {
      type: 'prerequisite-nudge',
      tool: meta?.attemptedTool ?? fallbackOffender?.function?.name ?? '<unknown>',
      missing: meta?.missing ? [...meta.missing] : [],
    };
    return 'prereq';
  }
  if (stepCheck?.nudge) {
    const attemptedTerminal = toolCalls.find(tc => {
      const n = tc.function?.name;
      return typeof n === 'string' && terminalTools?.includes(n);
    });
    yield {
      type: 'step-nudge',
      tier: stepCheck.nudge.tier,
      attemptedTool: attemptedTerminal?.function?.name ?? '<unknown>',
      pending: enforcer.pending(),
    };
    return 'step';
  }
  return null;
}
