# core/agent — orientation

Turn-loop orchestration. If you're modifying how a turn runs (model call → parse → tool dispatch → recovery → compaction trigger), you're in the right place.

## Public entry

`runAgent()` (`run-agent.ts`) — async generator yielding `AgentEvent`. Caller consumes the stream; see `src/ui/headless.ts` and `src/ui/tui/agent-loop/run-loop.ts` for the two pumps.

## Files

- `run-agent.ts` (~260 LOC) — the outer turn loop. Setup + while-loop + outer try/catch; per-phase work lives in the `phase-*.ts` files. Don't move work back inline (see below).
- **Pipeline phases** — each per-turn step is its own file. They yield `AgentEvent` and return a phase-specific discriminated union (NOT a bare `TurnOutcome` — see below):
  - `phase-types.ts` — `TurnState`, `TurnOutcome`, `TurnExit`, `finalizeTurn()`. The shared vocabulary every phase uses.
  - `phase-preflight.ts` — `runPreflight`: activation re-read, compaction, tool-definition snapshot, `pre-turn-stats`. Returns `PreflightSuccess | PreflightFailure` (failure carries a `TurnExit`).
  - `phase-model-call.ts` — `runModelCall`: chain pointer + `callModel` + rotation + mid-stream abort + `parseModelResponse`. Returns `ModelCallSuccess | ModelCallFailure` (both carry an updated `TurnState`; failure also carries a `TurnExit`).
  - `phase-response-emission.ts` — `runResponseEmission`: Respond short-circuit, `text-done` / `output-cap-reached` / `output-blocked`, `addAssistant`, chain-pointer capture. Returns `ResponseEmissionResult` with `outcome: TurnExit | null`.
  - `phase-no-tool-calls.ts` — `runNoToolCalls`: validator retry-nudge, silent-turn warning, prior-failure corrective message, auto-retry-exhausted emission. Returns `{ kind: 'continue' } | { kind: 'done'; stopReason: 'completed' }`.
  - `phase-enforcement.ts` — `runEnforcement`: prereq + step nudges. Returns `{ kind: 'pass' } | { kind: 'continue' } | { kind: 'done'; stopReason: 'error'; error: Error }` (raises `StepEnforcementError` / `PrerequisiteError` as the `done error` variant).
  - `phase-post-execution.ts` — `runPostExecution`: clean-batch settle, hard-error budget, all-denied halt, same-failure halt. Returns `TurnExit | null`.
- `call-model/` — model invocation, retry, key/tuple rotation, weak-tier auto-enable.
- `tool-calls/` — tool dispatch, permission gate, dedup, correction loop, cache.
- `cache/` — Read-tool result cache + prompt-cache boundary placement.
- `compaction.ts` — sequencer; delegates algorithms to `core/context/`.
- `parse-response.ts` — raw model output → `toolCalls` + `storedContent`.
- `recovery-state.ts` — `RecoveryState`: hard-error counters, last failure signature.
- `step-enforcer.ts` — `StepEnforcer`: prerequisite + required-step gates.
- `step-tracker.ts` — `StepTracker`: emitted-completion bookkeeping.
- `reliability-config.ts` — per-model auto-enable for the small-model reliability stack.
- `nudges.ts` — canned retry / unknown-tool / prerequisite / step nudges injected as user messages.
- `validator.ts` — `validateResponse()`: structural checks before accepting model output.
- `reasoning.ts` — fold + serialize reasoning blocks for providers that surface them.
- `errors.ts` — typed errors (`StepEnforcementError`, `PrerequisiteError`, `ToolExecutionError`).
- `types.ts` — `AgentEvent` discriminated union, `AgentOptions`, `RotationOptions`, `ResponsesChain`.

## The pipeline contract

Every per-turn phase is an `AsyncGenerator<AgentEvent, R>` where `R` is a **phase-specific discriminated union**, not a bare `TurnOutcome`. The shared vocabulary in `phase-types.ts` is:

```ts
type TurnOutcome =
  | { kind: 'continue' }
  | {
      kind: 'done';
      stopReason: 'completed' | 'user-abort' | 'token-limit' | 'error';
      error?: Error;
    };
type TurnExit = Extract<TurnOutcome, { kind: 'done' }>;
```

Phases compose these. The actual return shapes today:

| Phase                 | Return type                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `runPreflight`        | `PreflightSuccess` (with `activation`, `toolDefinitions`) \| `PreflightFailure` (carries `TurnExit`) |
| `runModelCall`        | `ModelCallSuccess` (carries `TurnState`, `result`, `parsed`) \| `ModelCallFailure` (carries both)    |
| `runResponseEmission` | `ResponseEmissionResult` with `outcome: TurnExit \| null`                                            |
| `runNoToolCalls`      | `{ kind: 'continue' } \| { kind: 'done'; stopReason: 'completed' }`                                  |
| `runEnforcement`      | `{ kind: 'pass' } \| { kind: 'continue' } \| { kind: 'done'; stopReason: 'error'; error: Error }`    |
| `runPostExecution`    | `TurnExit \| null`                                                                                   |

The reason for the per-phase unions (vs. a single `TurnOutcome` everywhere) is the success path: every phase passes phase-specific data forward (`activation`, `toolDefinitions`, model result, parsed tool calls, `deniedCount`, …). A bare `TurnOutcome` couldn't carry it. The unions are nominally distinct so a phase that returns the wrong shape fails to compile at the call site.

Three rules the contract enforces:

1. **Phases that update state return the full new state.** `runModelCall` may rotate `provider` / `model` / `lastUsage`; the outer loop destructures `({ provider, model, lastUsage } = call.state)`. Returning a `TurnState` rather than a patch makes it impossible to forget to apply a field — the phase's return type forces it to construct a complete `TurnState`.
2. **Controlled exits vs. unexpected throws.** A phase that wants to end the turn returns a `TurnExit` (either as the whole return or wrapped in a phase-specific discriminator). Unexpected exceptions (network, provider SDK, JSON parse, OOM) propagate to the outer try/catch in `runAgent`, which classifies abort-vs-error and finalizes. **Phases must NOT wrap their bodies in a catch-all that converts every exception to a `done error` outcome** — duplicating the outer catch is exactly the smear the pipeline split is preventing. Only typed-error catches (e.g. `phase-enforcement.ts` catching `StepEnforcementError`) belong inside a phase.
3. **`finalizeTurn` owns the exit triplet.** Every `done` outcome funnels through `yield* finalizeTurn(options, turnsUsed, lastUsage, outcome)`, which yields the `error` event (if any), fires the Stop hook, and yields `turn-complete`. The only exception is the outer try/catch at the bottom of the loop — it inlines the same shape because the abort-vs-error classification has to run BEFORE the stop hook fires.

The outer loop after the split is ~60 lines of `for (;;) { ... yield* phase(); switch (result.kind) { 'continue': continue; 'done': yield* finalizeTurn(...); return; 'pass'/null: fall through } }`.

## Adding a phase

If you find yourself adding a helper to `run-agent.ts`, make it a phase file instead:

1. Pick a name: `phase-<verb>.ts`.
2. Decide the output. Two patterns are in use:
   - **Carrying success data forward** → declare a phase-specific union (`PhaseSuccess | PhaseFailure`) where the failure variant wraps a `TurnExit`. Examples: `runPreflight`, `runModelCall`, `runResponseEmission`.
   - **No success data needed** → declare a small discriminator (`{ kind: 'pass' | 'continue' | 'done' }`) or `TurnExit | null`. Examples: `runEnforcement`, `runNoToolCalls`, `runPostExecution`.
3. If the phase mutates per-turn state (`provider` / `model` / `lastUsage`), include a `TurnState` in its return so the outer loop can re-apply.
4. The outer loop calls it as `yield* runMyPhase(options, { ... })` and pattern-matches on the result. `finalizeTurn(options, turnsUsed, lastUsage, outcome)` handles the `error` + Stop hook + `turn-complete` triplet for every `done` exit.

## Shared mutable state cheatsheet

If you're editing `run-agent.ts`, you'll see these names. They are explicit fields, not magic:

| Name                               | Mutated by                                       | Read by                                          |
| ---------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| `recovery` (RecoveryState)         | `runToolCalls`, retry branches                   | every error/exit path                            |
| `lastUsage`                        | `callModel`                                      | turn-complete emissions, context-fullness checks |
| `provider`, `model`                | rotation branches in `call-model/`               | model call, cache-boundary placement             |
| `turnsUsed`                        | one increment per loop iteration                 | budget checks, all exit paths                    |
| `emittedStepCompletions` (Set)     | `settleCleanBatch`                               | dedup guard for `step-completed` events          |
| `chainRef` (Responses-API pointer) | `captureChainPointer` after each successful turn | next call's input slice                          |

Don't introduce new ambient state. If you need persistence across iterations, extend `RecoveryState` (typed) rather than adding loose locals.

## Invariants enforced in `test/unit/arch/modularity.test.ts`

When you touch model invocation, rotation, or selection, verify these still pass:

- Acyclic imports inside `core/agent/`.
- `ModelSelection` shape must not be re-declared (no parallel DTOs for `{provider, model, keyId}`).
- "Prime-before-use" for providers — `prime()` must run before `chat()` / `chatNoStream()`.
- `RecoveryState` is the only carrier for cross-turn error/retry state.

## Subagents (`core/subagent/`)

`core/subagent/` is a thin wrapper around the same `runAgent` you're looking at — it's not a separate runtime. The `Delegate` tool (`src/tools/delegate.ts`) calls `runSubagent`, which spins up `runAgent` with a hardened registry, a fresh `PermissionManager`, and an external tool-call cap.

### Files

- `runner.ts` — `runSubagent`, `buildSubagentRegistry`, `makeRestrictedBashTool`, `SUBAGENT_SYSTEM_PROMPT`.
- `bash-allowlist.ts` — `isCommandAllowed`: per-command read-only allow-list (`ls`, `cat`, `head`, `tail`, `find`, `wc`, `pwd`, `which`, …). Anything outside this list is rejected before `spawn`.

### Hardening — defense in depth, not prompt-defense

The safety story is structural, not "we asked the model nicely":

1. **Restricted registry.** `buildSubagentRegistry()` constructs a `ToolRegistry({ empty: true })` and registers only `Read`, `Glob`, `Grep`, and the wrapped Bash. Edit / Write / WebFetch are never registered — the subagent has no way to call them regardless of what its prompt or model says.
2. **Bash allow-list.** `makeRestrictedBashTool` wraps `bashTool` with `isCommandAllowed`. Disallowed commands return a `ToolResult` failure synchronously; `spawn` never runs.
3. **Fresh `PermissionManager`** with all four tools auto-allowed. The subagent has no human in the loop — interactive prompts would deadlock — so the safety story above replaces the permission-prompt UX.
4. **External tool-call cap.** `SUBAGENT_TOOL_CALL_LIMIT = 80`. The main loop has no `maxTurns`; the subagent counts `tool-call-start` events and `abort()`s the controller when the budget is spent. The resulting `user-abort` stop reason is relabelled to `turn-limit` so callers can distinguish "ran over budget" from "user pressed Esc".

### Typing

`makeRestrictedBashTool` returns `BashToolHandler` (not `StandardToolHandler`) and its `execute` returns `Promise<BashToolResult>`. This is load-bearing: the subagent's Bash wrapper must surface `cwdAfter` correctly so the inner shell's `cd` propagates exactly as it does in the parent loop. The `kind: 'bash'` discriminator is what lets the executor in `tool-calls/run-tool-calls-execute.ts` narrow on it.

### Don't

- **Don't pass `Edit` / `Write` / `WebFetch` to the subagent registry.** _Folklore:_ no mechanical check. The hardening story is "the subagent can only call read-only tools"; widening the registry breaks the contract advertised in `SUBAGENT_SYSTEM_PROMPT` and the Delegate tool's description.
- **Don't gate Bash safety on the system prompt.** _Folklore:_ no mechanical check today. The allow-list in `bash-allowlist.ts` is the gate. Removing the wrapper "because the prompt says read-only" reintroduces full shell access.
- **Don't widen `BashToolHandler` to `StandardToolHandler`** in `makeRestrictedBashTool`. _Enforced by type:_ the subagent's Bash wrapper has `kind: 'bash'`; changing it loses `cwdAfter` propagation. The standard-handler annotation would compile until the executor reads `cwdAfter`.
- **Don't remove the tool-call cap "because the main loop doesn't have one".** The main loop has a human in the loop; the subagent doesn't. A chatty model can investigate forever without the cap.
