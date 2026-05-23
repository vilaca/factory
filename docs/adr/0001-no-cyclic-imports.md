# 0001 — No cyclic imports anywhere under `src/`

- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

Module cycles are the seed of every "I can't reason about this code" complaint. They make refactors transitive (touch one file, the entire cycle becomes load-bearing), break tree-shaking, and turn import-order bugs into mysteries. Most projects discover cycles only when a new file finally trips the runtime; the existing cycles are unaudited.

A coding-agent codebase is especially vulnerable because tool registries, event types, and renderer state naturally tempt circular imports — and because the project relies on small modules per concern, a single accidental cycle ripples through many files.

## Decision

`src/**` has no cyclic imports. The invariant is enforced by ArchUnitTS in `test/unit/arch/modularity.test.ts` via `projectFiles().inFolder('src/**').should().haveNoCycles()`. The test runs as part of the unit suite, so a cycle introduced in a PR fails CI before review.

## Consequences

**Easier.**

- Every file under `src/` has an acyclic dependency graph. Refactors are local: change one file, the blast radius is its callers, not a cycle's worth of co-dependents.
- New contributors can read a file top-to-bottom without "wait, A imports B which imports A" puzzles.
- Bundle-analysis and dead-code tools (knip is already a dev dep) can report meaningful results without first untangling cycles.

**Harder.**

- A genuinely needed mutual reference between two modules forces a third file (a shared types module, an interface) — slight friction by design.
- The ArchUnit check is a small CI cost; tolerable.

**Invariants future contributors must preserve.**

- Do not weaken or remove the `haveNoCycles()` check. If a cycle is unavoidable, write a superseding ADR explaining why and what scope-restricted exception applies.
- When two modules want to refer to each other, introduce a shared dependency, don't make one re-export the other.
