# 0011 — `AgentEvent` as the single contract between core loop and renderers

- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

factory has two renderers — an Ink/React TUI and a non-TTY headless mode used for scripted runs and CI — and the goal of "same agent, no UI" requires that both consume identical core behavior. The temptation under deadline is to add a renderer-specific callback or pass UI state down into the core loop ("the TUI needs to know X before Y happens"); each such hook permanently couples the loop to that renderer and silently breaks the other.

The same problem exists for future renderers: an ACP server mode for editor extensions (planned in M4), a hosted variant, or a second TUI experiment. None of them can be built cleanly if the core loop already knows about Ink components.

## Decision

`runAgent` (in `src/core/agent/run-agent.ts`) is an async generator whose sole output is a `AgentEvent` stream, defined as an exhaustive discriminated union in `src/core/agent/types.ts`. Every renderer consumes the same stream and is responsible for mapping events to its own state model. Renderers do not call into the core loop except via `AgentEvent.respond` callbacks attached to specific event variants (currently `permission-request`). The core loop must not import from `src/ui/`.

New core-loop signals add a variant to `AgentEvent` — they never become a renderer-specific callback or shared mutable state.

## Consequences

**Easier.**

- The headless renderer (`src/ui/headless.ts`) and the TUI's `event-handler.ts` are siblings, not derivatives. Adding a third renderer is a third consumer; the loop doesn't change.
- Tests of the agent loop are tests of the event stream — no UI harness needed. Snapshot the event sequence; assert.
- Session logging is also an event consumer (`session-log.ts`) and proves the contract by being a third independent reader.

**Harder.**

- Adding a new event variant is a multi-file change by construction: the union, every renderer's switch, and the session log all must handle it. This is *intentional* friction — it ensures both renderers stay synchronized. a future ADR will codify this via `assertNever`.
- "Respond" callbacks attached to events are the only back-channel and they must remain synchronous and idempotent — once the renderer responds, the loop continues. New back-channel needs should reuse `permission-request`'s shape rather than invent ad-hoc callback fields.

**Invariants future contributors must preserve.**

- `src/core/` has no dependency on `src/ui/`. Direction is one-way.
- `runAgent` yields events; it does not invoke renderer code directly.
- Every variant in `AgentEvent` is consumed by both `event-handler.ts` and `headless.ts`. A variant consumed by only one is a bug.
