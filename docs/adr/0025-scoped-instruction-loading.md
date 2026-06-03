# 0025 — Scoped instruction files are loaded on demand, not at session init

- **Status:** Accepted
- **Date:** 2026-06-03
- **Supersedes:** —
- **Superseded-by:** —

## Context

The runtime previously loaded all project instruction sources at startup from the launch directory:

1. `.factory/INSTRUCTIONS.md`
2. `AGENTS.md`
3. `CLAUDE.md`
4. `.cursorrules`

That design had two problems:

- **Overreach at init.** The agent was influenced by directory-specific guidance before it had touched any files in those directories.
- **Missed locality.** If work moved into nested directories with their own guidance files, startup-time loading from root alone could miss or flatten the intended scope semantics.

## Decision

Split instruction loading into two tiers:

1. **Startup tier (eager):** `.factory/AGENTS.md` and `.factory/INSTRUCTIONS.md` are loaded at session initialization.
2. **Scoped tier (lazy):** root/directory `AGENTS.md`, `CLAUDE.md`, and `.cursorrules` are discovered and loaded during execution based on the directories the agent actually touches.

Scoped discovery rules:

- The **project root boundary is the startup cwd**. Parent walks never climb above it.
- For each touched directory, scan that directory and its parents up to project root.
- Merge sources in **root → child** order so deeper/local rules appear later in the prompt.
- Keep existing size cap/truncation behavior and per-source `## From <path>` headers.

Prompt update rules:

- After successful file/search tool calls (Read/Edit/Write/Glob/Grep), refresh scoped instructions.
- If scoped content changes, update the live system prompt and emit an agent event (`scoped-project-instructions-updated`) so TUI/headless surfaces and session logs record the change.

## Consequences

**Easier.**

- Guidance now follows actual work scope instead of global startup assumptions.
- Nested-directory conventions apply naturally as the agent navigates the tree.
- Observability is explicit: prompt changes from scoped instruction discovery are evented and logged.

**Harder.**

- Prompt composition is now dynamic during a turn lifecycle, not fixed after init.
- Hosts must preserve callback plumbing from tool execution to prompt refresh.
- Tests must model both startup instructions and runtime scoped discovery.

## Invariants future contributors must preserve

- `.factory/AGENTS.md` and `.factory/INSTRUCTIONS.md` remain startup-only and rooted at launch cwd.
- Scoped files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`) are loaded only from touched directories + ancestors up to project root.
- Parent traversal must not escape the startup cwd boundary.
- Ordering remains root → child.
- Any change to scoped instruction content must trigger a system-prompt refresh and corresponding event emission.
