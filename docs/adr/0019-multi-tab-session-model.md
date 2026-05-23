# 0019 — Multi-tab session model: each tab is an independent agent

- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

A practical coding workflow routinely needs multiple agents in flight: a frontier model is grinding through a refactor in one place while a cheap local model explores tests, or two investigations of different bugs run side by side. Forcing the user to spawn new processes for each (separate terminal, separate auth, separate session log) loses cache state and adds operational overhead; folding them into one conversation poisons each agent with the other's context.

The natural unit of isolation is the tab: independent conversation, independent cwd, independent provider/model, but a *shared* credential store and a *shared* hotkey/UI shell.

## Decision

The TUI presents tabs as independent agent sessions. Each tab in `src/ui/tui/tabs/` owns its own `Conversation`, working directory, provider, model, and session log; the only state shared across tabs is the credential store and global UI configuration. Tab switching is `Ctrl+N` / `Ctrl+P` for cycling, `F1`–`F12` for direct selection. The agent loop has no notion of tabs — it sees one conversation and one set of options. The tab host (`src/ui/tui/App.tsx`) wires the right context into each tab's `Session.tsx`.

## Consequences

**Easier.**

- Running multiple investigations in parallel is one keystroke. Each preserves its prompt-cache hit rate independently.
- The mental model is unsurprising: a tab is what a terminal window would have been, with shared auth.
- Headless mode is unaffected — a one-shot script doesn't pay any tab cost because the TUI tab machinery isn't loaded.

**Harder.**

- Resource use scales with active tabs. A frontier-model tab idling still holds its conversation in memory; a future enhancement may suspend inactive tabs.
- Cross-tab coordination is intentionally not supported in this version — a future "delegate to another tab" feature (planned in `feat/subagent-delegate` follow-ups) would need a new mechanism that doesn't break the no-shared-state invariant.
- Credential store access is shared, which means rotation events in one tab affect another. The session log carries enough detail to disentangle but it's a real coupling.

**Invariants future contributors must preserve.**

- Tabs share credentials and global UI config only. Conversations, cwd, providers, models, session logs are per-tab.
- The agent loop does not import from `src/ui/tui/tabs/`. The tab abstraction is a UI concept, not a core concept.
- Hotkey bindings for tab management are in the UI layer (`src/ui/tui/hooks/use-session-input.ts`). The agent loop has no opinion on them.
