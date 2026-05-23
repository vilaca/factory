# 0021 — Renderer split: Ink TUI vs plain-stdout headless, one core loop

- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

factory must run in two unrelated environments: an interactive terminal where humans want a rich UI (multi-tab, status bar, permission prompts, sparklines) and a non-TTY scripted environment (CI, shell pipelines, `echo … | factory`) where Ink components are noise that breaks tooling. Maintaining two separate agents — one Ink-aware, one pipe-aware — would mean every behavior change happens twice, with predictable drift.

Ink (React for terminal) is a strong fit for the interactive case (component composition, hooks, declarative state) but pulls in a non-trivial runtime that has no business running in a script.

## Decision

There are two renderers and one core loop. The interactive path uses Ink/React under `src/ui/tui/`; the non-TTY path is `src/ui/headless.ts`, which writes plain stdout/stderr and exits with structured codes (1=error, 3=permission blocked, 5=token limit). Both call `runAgent` from `src/core/agent/run-agent.ts` and consume the same `AgentEvent` stream (see [ADR 0011](0011-agent-event-contract.md)). `isInteractiveTty` at startup dispatches between them. Neither renderer is allowed to fork the agent loop.

Slash commands and tab management are TUI-only concerns and live under `src/ui/tui/`. They are not loaded in headless mode.

## Consequences

**Easier.**

- A behavior change to the agent — new event, new compaction rule, new resilience layer — automatically applies to both renderers.
- Headless is *the same agent*, not a feature-stripped variant. The promise in the README ("same agent, no UI") is preserved by construction.
- Adding a third renderer (ACP server in M4, future hosted variant) is a third consumer of `AgentEvent`. The core loop doesn't change.

**Harder.**

- Headless cannot prompt for permission, so it has to refuse-and-exit on `permission-request` (exit code 3). Users running scripts must pre-approve via flags or trust the working directory. This is the right behavior — silently approving in CI would be a footgun.
- The TUI carries the Ink dependency cost for everyone, but the headless path doesn't load `src/ui/tui/` at all, so script invocations stay light.

**Invariants future contributors must preserve.**

- `src/core/` does not import from `src/ui/`. Direction is one-way.
- New core behavior is exposed as an `AgentEvent` variant, never as a renderer-specific callback.
- Slash-command logic stays under `src/ui/tui/slash/`. Headless does not interpret `/commands`; input that starts with `/` is sent as plain text.
