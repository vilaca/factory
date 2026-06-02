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

## A. Layer Dependency Rules

Enforce one-way dependency flow and prohibit layer skipping.

### Required constraints

- `src/core/**` must not depend on `src/ui/**` or `src/cli/**`.
- `src/core/**` must not depend on concrete provider/tool implementations.
- `src/security/**` must stay primitive (no dependency on sibling top-level layers).
- `src/providers/**` must not depend on `src/ui/**`, `src/tools/**`, `src/core/**`, `src/mcp/**`, `src/cli/**`.
- `src/ui/**` must not depend on `src/mcp/**`.

These are currently enforced in `modularity.test.ts` and should remain enforced.

---

## B. Boundary Surface Rules

Only stable seams are allowed across boundaries.

### Required constraints

- Cross-layer imports must go through seam files (`types.ts`, `registry.ts`, etc.).
- Internal adapters stay internal (e.g., `src/providers/openai/**`).
- MCP SDK imports are confined to adapter boundary files.

---

## C. Runtime Safety/Policy Rules

Architectural correctness includes key runtime invariants.

### Required constraints

- Provider mint + capability read must include priming.
- Config read-modify-write must use atomic update API.
- Security must use policy snapshots, not ambient `process.cwd()` / `process.env`.
- Production code must not use mutable global singleton tool registry.

---

## D. IO/Integration Boundary Rules

Keep side effects behind intended layers.

### Required constraints

- UI must not import network SDKs directly.
- UI must not import Node networking/child-process modules directly.
- `console.*` usage is restricted to explicit startup/bootstrapping boundaries.

---

## E. Structural Hygiene Rules

Prevent long-term drift.

### Required constraints

- No cycles in `src/**`.
- Provider classes must be registered in `src/providers/registry.ts`.
- Do not introduce external CLI argument parser libraries.

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
