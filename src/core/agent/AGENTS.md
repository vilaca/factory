# core/agent — orientation

Turn-loop orchestration. If you're modifying how a turn runs (model call → parse → tool dispatch → recovery → compaction trigger), you're in the right place.

## Public entry

`runAgent()` (`run-agent.ts:396`) — async generator yielding `AgentEvent`. Caller consumes the stream; see `src/ui/headless.ts` and `src/ui/tui/agent-loop/run-loop.ts` for the two pumps.

## Files

- `run-agent.ts` (799 LOC) — the turn loop itself. Don't split it (see below).
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

## Why `run-agent.ts` is not split

799 LOC is a smell, not a defect here. The file is orchestration glue — a single `while(true)` loop whose phases share mutable state (`recovery`, `lastUsage`, `provider`, `model`, `turnsUsed`, `emittedStepCompletions`). Each phase reads and mutates fields the previous phase set; splitting smears state across files without reducing complexity. The extractable pieces are already extracted (`call-model/`, `tool-calls/`, `compaction.ts`, `parse-response.ts`, `step-enforcer.ts`, `recovery-state.ts`). If you need to add complexity here, add a small pure helper in `run-agent.ts` itself (lines 24–393 are the existing pattern: single-use helpers called from exactly one site).

## Shared mutable state cheatsheet

If you're editing `run-agent.ts`, you'll see these names. They are explicit fields, not magic:

| Name | Mutated by | Read by |
|---|---|---|
| `recovery` (RecoveryState) | `runToolCalls`, retry branches | every error/exit path |
| `lastUsage` | `callModel` | turn-complete emissions, context-fullness checks |
| `provider`, `model` | rotation branches in `call-model/` | model call, cache-boundary placement |
| `turnsUsed` | one increment per loop iteration | budget checks, all exit paths |
| `emittedStepCompletions` (Set) | `settleCleanBatch` | dedup guard for `step-completed` events |
| `chainRef` (Responses-API pointer) | `captureChainPointer` after each successful turn | next call's input slice |

Don't introduce new ambient state. If you need persistence across iterations, extend `RecoveryState` (typed) rather than adding loose locals.

## Invariants enforced in `test/unit/arch/modularity.test.ts`

When you touch model invocation, rotation, or selection, verify these still pass:
- Acyclic imports inside `core/agent/`.
- `ModelSelection` shape must not be re-declared (no parallel DTOs for `{provider, model, keyId}`).
- "Prime-before-use" for providers — `prime()` must run before `chat()` / `chatNoStream()`.
- `RecoveryState` is the only carrier for cross-turn error/retry state.
