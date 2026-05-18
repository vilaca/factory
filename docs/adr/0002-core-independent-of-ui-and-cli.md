# 0002 — `src/core/` has no dependency on `src/ui/` or `src/cli/`

- **Status:** Accepted
- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

The agent loop has multiple consumers — interactive TUI, headless stdout, future ACP server, eval harness — and each consumer is itself a renderer of the same loop's events. The moment the core loop imports from a specific renderer, that renderer becomes load-bearing for every other renderer (a change to the TUI accidentally breaks headless; a change to CLI parsing leaks into the model call).

The same reasoning applies to the CLI: argv parsing is a startup-time entry-point concern. If the core loop reaches into `src/cli/` for, say, "what flags is the user running with?", it becomes impossible to drive the loop from anywhere else (a server, a test, a library).

## Decision

`src/core/**` must not depend on `src/ui/**` or `src/cli/**`. The dependency direction is fixed: CLI and UI compose the core; the core has no knowledge of either. Enforced in `test/unit/arch/modularity.test.ts` with `projectFiles().inFolder('src/core/**').shouldNot().dependOnFiles().inFolder('src/ui/**' | 'src/cli/**')`. CI fails on violation.

## Consequences

**Easier.**

- New renderers (ACP server, eval harness, hosted variant) are net-additive — they import from `src/core/`, the reverse is impossible by construction.
- The core loop is testable without spinning up Ink or parsing argv.
- Behavior changes to the loop apply uniformly to every renderer because there is no per-renderer escape hatch.

**Harder.**

- Renderer-specific signals must travel via `AgentEvent` (see [ADR 0011](0011-agent-event-contract.md)) or via callbacks attached to specific event variants. The core cannot say "if running under TUI, do X."
- A genuine cross-cutting concern (e.g. a config field that the loop needs and the CLI sets) must thread through an options argument, not be read from the CLI parser directly.

**Invariants future contributors must preserve.**

- Do not weaken the ArchUnit rules in `test/unit/arch/modularity.test.ts`. Adding an exception requires a superseding ADR.
- If the core loop needs a piece of CLI/UI state, accept it as a parameter; do not import to find it.
