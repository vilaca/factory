# Modularity Rules (Enforced Architecture)

This document defines **non-negotiable modularity constraints** for this codebase.

The goal is to enforce architecture continuously through tests/CI, instead of relying on occasional refactors.

---

## 1) Principles

1. **Boundaries are enforced by code, not convention.**
2. **Violations fail CI.**
3. **Exceptions are explicit, temporary, and tracked.**
4. **Rule changes are architecture changes** and must be reviewed as such.

---

## 2) Source of Truth

- High-level intent: `ARCHITECTURE.md`, `REFACTOR.md`
- Enforcement: `test/unit/arch/modularity.test.ts`
- This file defines the policy layer and expected review/CI behavior.

---

## 3) Rule Categories

### A. Layer Dependency Rules

Enforce one-way dependency flow and prohibit layer skipping.

#### Required constraints

- `src/core/**` must not depend on `src/ui/**` or `src/cli/**`.
- `src/core/**` must not depend on concrete provider/tool implementations (only seam files — see B).
- `src/security/**` must stay primitive (no dependency on sibling top-level layers).
- `src/providers/**` must not depend on `src/ui/**`, `src/tools/**`, `src/core/**`, `src/mcp/**`, `src/cli/**`.
- `src/ui/**` must not depend on `src/mcp/**`.
- `src/ui/**` must not import concrete provider implementations (only seam files — see B).
- `src/ui/**` must not import concrete tool handler files (only seam files — see B).
- `src/ui/headless.ts` must not depend on `src/ui/tui/**`.
- `src/utils/**` must not depend on any sibling top-level folder.

These are currently enforced in `modularity.test.ts` and should remain enforced.

---

### B. Boundary Surface Rules

Only stable seams are allowed across boundaries.

#### Required constraints

- Cross-layer imports must go through declared seam files. The canonical seam sets per boundary are defined in `modularity.test.ts` (the `except:` arrays in the relevant rules). Changing a seam set is an architecture change; update both the test and this section together.
- `src/providers/openai/**` is an internal adapter — only files within `src/providers/**` may import from it.
- `@modelcontextprotocol/sdk` imports are confined to `src/mcp/client.ts` and `src/mcp/adapter.ts`.

---

### C. Runtime Safety/Policy Rules

Architectural correctness includes key runtime invariants.

#### Required constraints

- Security must use policy snapshots, not ambient `process.cwd()` / `process.env`.
- Production code must not use mutable global singleton tool registry (`defaultRegistry`).

---

### D. IO/Integration Boundary Rules

Keep side effects behind intended layers.

#### Required constraints

- UI must not import network SDKs directly.
- UI must not import Node networking/child-process modules directly.
- `console.*` usage is restricted to files that run before the TUI mounts (startup and MCP connection surface). The canonical allowlist is in the `console.*` rule in `modularity.test.ts`; additions require the same pre-TUI justification documented there.

---

### E. Structural Hygiene Rules

Prevent long-term drift.

#### Required constraints

- No cycles in `src/**`.
- Provider classes must be registered in `src/providers/registry.ts`.
- Do not introduce external CLI argument parser libraries.

### F. Regression Contracts

Rules that encode a specific past bug. Each names the commit that motivated it. Removing a regression contract requires demonstrating that the structural fix it guards is now enforced by the type system or a stronger rule.

#### Required constraints

- **cf880ed** — Provider mint + capability read must include priming (`prime` / `listModels` / `primeModelCache`). The primary gate is the `UnprimedProvider` return type from `createProvider`; this rule is belt-and-braces.
- **f848472** — Config read-modify-write must use `updateGlobalConfig`, not a bare `loadGlobalConfig` + `saveGlobalConfig` pair.
- **44aeb26** — `status-bar.tsx` must read context fullness only via `contextFillTokens`; direct `.totalTokens` / `.completionTokens` / `.reasoningTokens` field access is forbidden.
- **550f093** — The `{ provider, model, keyId }` DTO shape must not be re-declared outside `src/core/selection/types.ts`; alias or extend `ModelSelection`.
- Shared event-render helpers (`describeRotationReason`, `fingerprintLabel`, `formatHookDisplay`) must live only in `src/ui/agent-events/render.ts`.

---

## 4) Exception Policy (Allowlist Discipline)

Any exception to a rule must include:

1. **Why** it is currently necessary
2. **Where** it is tracked (issue/TODO)
3. **Exit condition** (what change removes it)
4. **Owner** responsible for removal

### Hard requirements

- No silent allowlist additions.
- No broad wildcard exceptions when a file-level exception is possible.
- New exception must be mentioned in PR description under an “Architecture Exception” heading.

---

## 5) CI Enforcement

Architecture tests are required checks.

Minimum CI gate:

- `npm run test:unit:rest` (includes `test/unit/arch/**/*.test.ts`)

Recommended explicit gate (future):

- Add `npm run test:unit:arch` script:
  - `tsx --test 'test/unit/arch/**/*.test.ts'`
- Mark it as a required status check.

---

## 6) Rule Lifecycle

When adding a new cross-layer behavior:

1. Update `ARCHITECTURE.md` (intent)
2. Add/adjust architecture test (enforcement)
3. Update this file if policy category changes
4. Merge all three in one PR

When fixing a violation:

1. Prefer changing code over changing rule
2. If rule must change, explain architectural rationale
3. Remove stale comments/TODOs tied to old allowlists

---

## 7) PR Checklist (copy/paste)

- [ ] Does this introduce a new dependency edge across top-level folders?
- [ ] If yes, is it through an approved seam file?
- [ ] Did any architecture allowlist grow?
- [ ] If allowlist grew, is there a tracked removal plan + owner?
- [ ] If allowlist grew, is it mentioned in the PR description under an "Architecture Exception" heading?
- [ ] Do architecture tests still pass locally?
- [ ] Are docs (`ARCHITECTURE.md` / this file) updated if behavior changed?

---

## 8) Suggested Next Tightening Steps

1. **Add dedicated script** `test:unit:arch` in `package.json`.
2. **Split `modularity.test.ts`** into focused files per category:
   - `layers.test.ts`
   - `boundary-surfaces.test.ts`
   - `runtime-contracts.test.ts`
   - `io-boundaries.test.ts`
3. **Add allowlist metadata format** (comment template with owner + removal condition).
4. **Add CI diff guard** to flag allowlist growth automatically.

---

## 9) Non-Goals

- This policy does not require immediate monorepo/package split.
- This policy does not ban all duplication.
- This policy does not replace code review; it makes review safer.

---

## 10) Summary

Refactors are episodic. Rules are continuous.

We enforce modularity by making architecture testable, required in CI, and difficult to bypass accidentally.
