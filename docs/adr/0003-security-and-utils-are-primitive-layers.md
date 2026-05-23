# 0003 — `src/security/` and `src/utils/` are primitive layers with no sibling deps

- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

Two folders in `src/` are intended as foundational: `src/security/` (path jail, bash rules, env scrub, permission state machine — used by every tool dispatch) and `src/utils/` (small framework-free helpers like token estimation, glob matching, atomic writes). Both are leaves of the dependency graph by design: everyone imports them, they import no sibling top-level folder.

The temptation, especially under deadline, is to reach back upstream — "I'm in `security/` and I just need to ask `core/agent/` what the current model is" — which immediately creates a cycle (because `core/` imports `security/`) and turns a primitive into a non-primitive. [ADR 0001](0001-no-cyclic-imports.md) already bans cycles; this ADR pins the *direction* so a contributor doesn't have to reverse-engineer it.

## Decision

`src/security/**` and `src/utils/**` must not depend on any sibling top-level folder (`src/core/**`, `src/ui/**`, `src/cli/**`, `src/tools/**`, `src/providers/**`, `src/mcp/**`, and for `utils/` also `src/security/**`). They depend only on Node built-ins, `node_modules`, and each other where needed.

Enforced in `test/unit/arch/modularity.test.ts` by iterating each sibling folder and asserting `projectFiles().inFolder('src/security/**' | 'src/utils/**').shouldNot().dependOnFiles().inFolder(<sibling>)`.

## Consequences

**Easier.**

- `security/` and `utils/` are testable in isolation — no harness, no mocks of upstream concerns.
- Reasoning about a violation of the security model is local: every check lives in `security/`, nothing reaches outside it.
- Refactors in `core/` or `tools/` can never silently change security behavior.

**Harder.**

- A check that genuinely needs upstream context (e.g. "deny this path because we're in plan mode") must receive that context as a parameter rather than reading it from `core/`. The plan-mode example specifically lives in `core/agent/tool-calls/run-tool-calls-execute.ts` for exactly this reason (see [ADR 0012](0012-plan-mode-gating.md)).
- `utils/` may not depend on `security/` either — even though that seems harmless, it prevents future drift where a utility starts encoding policy.

**Invariants future contributors must preserve.**

- Both folders remain leaves of the dependency graph. A new sibling folder added later must be added to the ArchUnit deny list for `security/` and `utils/`.
- A helper that needs upstream knowledge does not live in `utils/`. Either it lives where the knowledge lives, or it accepts the knowledge as a parameter.
