# 0007 — `src/ui/headless.ts` must not depend on the TUI tree

- **Status:** Accepted
- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

The headless renderer (`src/ui/headless.ts`) drives the same `runAgent` loop as the TUI but writes plain stdout/stderr and exits with structured codes (see [ADR 0021](0021-renderer-split-tui-headless.md)). It runs in CI, in shell pipelines, in `echo prompt | factory` invocations — places where loading Ink, React, and the tab/component machinery is wrong (and sometimes outright impossible: no TTY, no terminal sizing).

If `headless.ts` imports anything from `src/ui/tui/`, the entire React/Ink tree is pulled in at startup whether it's used or not. Beyond cost, it couples behavior changes: a slash command added under `tui/slash/` could accidentally become reachable from headless (or import-cycle into something headless can't render).

The two paths must remain renderer-siblings of the same core loop, not parent-and-child.

## Decision

Files under `src/ui/**` *except* those under `src/ui/tui/**` must not depend on `src/ui/tui/**`. In practice this targets `src/ui/headless.ts` (currently the only non-TUI file under `src/ui/`), but the rule scales: any future renderer added directly under `src/ui/` inherits the same isolation from `tui/`.

Enforced in `test/unit/arch/modularity.test.ts` with `projectFiles().inFolder('src/ui/**', { except: 'src/ui/tui/**' }).shouldNot().dependOnFiles().inFolder('src/ui/tui/**')`.

## Consequences

**Easier.**

- Headless invocations don't pay the Ink load cost. Startup is faster, memory smaller, and a TTY-less environment can run the agent.
- The TUI is free to grow components, hooks, and tabs without leaking implementation into the scripted path.
- A future ACP server renderer (M4) lives as a peer of `headless.ts` and inherits the same TUI isolation by construction.

**Harder.**

- Helpers that *both* renderers need cannot live under `tui/`. They go in `src/ui/` (top-level) or in a shared `src/ui/format.ts` / similar leaf. The handful of helpers shared today (`renderer.ts`, `format.ts`) sit at the top level of `src/ui/` precisely for this reason.
- A new feature the user wants in both renderers must be plumbed via `AgentEvent` ([ADR 0011](0011-agent-event-contract.md)), not by sharing a TUI component.

**Invariants future contributors must preserve.**

- Helpers reachable from both renderers stay outside `src/ui/tui/`.
- The ArchUnit rule is for the non-TUI siblings: do not add an exception for "just this one TUI import" — that's the start of the coupling this ADR is meant to prevent.
