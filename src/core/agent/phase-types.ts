import type { Provider, TokenUsage } from '../../providers/types.js';
import type { AgentEvent, AgentOptions } from './types.js';
import { fireStopHook } from './hooks-runner.js';

/** The per-iteration mutable state that phases may update.
 *
 *  Phases that update any field return the **full new state**, not a
 *  patch — the outer loop does `({ provider, model, lastUsage } =
 *  result.state)`. Returning the whole thing makes it impossible to
 *  forget to apply a field: the phase's return type forces it to
 *  construct a complete `TurnState`, so a phase that updates only
 *  `lastUsage` still has to echo `provider` and `model` back.
 *
 *  Phases that don't update anything (preflight) take a `TurnState` as
 *  input and don't return one. Phases that may update (model-call) take
 *  the input state and return a new one. */
export interface TurnState {
  provider: Provider;
  model: string;
  lastUsage: TokenUsage | undefined;
}

/** Exit-state of one phase or of one iteration of the turn loop.
 *
 *  Phases that participate in the turn pipeline (preflight, model call,
 *  enforcement, post-execution, …) return their result alongside a
 *  `TurnOutcome` discriminator. The outer loop's response:
 *
 *  - `{ kind: 'continue' }` → loop again (e.g. retry-nudge injected,
 *    step-nudge fired).
 *  - `{ kind: 'done', ... }` → caller emits `finalizeTurn` and returns.
 *    `error` carries the `Error` to surface as an `error` event (omitted
 *    for non-error stops).
 *
 *  Phases may also `throw`. Unexpected exceptions propagate to the
 *  loop's outer try/catch, which converts them to a `done` outcome via
 *  the same path. **`TurnOutcome` is for *controlled* exits; `throw` is
 *  for *unexpected* ones.** Phases must NOT wrap every internal helper
 *  in a try/catch and return `{ kind: 'done', stopReason: 'error' }` —
 *  duplicating the outer catch is exactly the smear the pipeline split
 *  is trying to avoid. */
type TurnOutcome =
  | { kind: 'continue' }
  | {
      kind: 'done';
      stopReason: 'completed' | 'user-abort' | 'token-limit' | 'error';
      error?: Error;
    };

/** Convenience alias for the done variant — used by helpers that only
 *  ever receive the early-exit case. Re-export `TurnOutcome` from this
 *  file when a phase starts returning the `continue` variant (none does
 *  today; the first one will be the enforcement phase). */
export type TurnExit = Extract<TurnOutcome, { kind: 'done' }>;

/** Emit the `error` (if any) + Stop hook + `turn-complete` sequence for
 *  a `TurnOutcome` with `kind: 'done'`. The 7+ exit sites in
 *  `run-agent.ts` that yield this exact sequence collapse to:
 *
 *  ```ts
 *  if (outcome.kind === 'done') {
 *    yield* finalizeTurn(options, turnsUsed, lastUsage, outcome);
 *    return;
 *  }
 *  ```
 *
 *  Intentionally NOT consumed by the outer try/catch at the bottom of
 *  the loop — that catch already inlines the same shape, with an
 *  abort-vs-error split that has to run BEFORE the stop hook fires.
 *  Leaving it inline keeps the catch self-contained. */
export async function* finalizeTurn(
  options: AgentOptions,
  turnsUsed: number,
  lastUsage: TokenUsage | undefined,
  outcome: TurnExit,
): AsyncGenerator<AgentEvent> {
  if (outcome.error) {
    yield { type: 'error', error: outcome.error };
  }
  yield* fireStopHook(options, turnsUsed, outcome.stopReason);
  yield { type: 'turn-complete', stopReason: outcome.stopReason, turnsUsed, usage: lastUsage };
}
