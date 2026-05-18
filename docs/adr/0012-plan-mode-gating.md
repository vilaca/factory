# 0012 — Plan mode: read-only tools execute freely; writes are queued

- **Status:** Accepted
- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

Untrusted models — local 7B-class checkpoints, new frontier releases not yet exercised on this repo, anything running headless on a CI runner — should not be able to mutate the filesystem on first turn. But the alternative ("approve every tool call") is unusable: a typical investigation involves dozens of Read/Grep/Glob calls, none of which carry risk, and prompting on each one trains the user to mash "yes" until the actual destructive call slips through.

The distinction that matters is not "tool name" but "does this call mutate observable state?" — and that distinction is stable across the tool surface (Read/Glob/Grep/WebFetch read; Write/Edit/Bash can mutate; Delegate is a transitive concern handled separately).

## Decision

Plan mode (`--plan`) gates everything except `read-only` tools. Each `ToolHandler` declares a `category` of `'read-only' | 'write' | 'execute'` (`src/tools/types.ts`); `Read`, `Glob`, `Grep`, and `Delegate` are `read-only`, `Write` and `Edit` are `write`, `Bash` is `execute`, and MCP tools are uniformly `execute` (see [ADR 0016](0016-mcp-as-toolhandlers.md)). The plan-mode gate lives in `src/core/agent/tool-calls/run-tool-calls-execute.ts` (`if (ctx.planMode && tool.category !== 'read-only')`), *not* inside individual tool handlers, so the rule is in one place and a new tool inherits the correct default by declaring its category.

`src/security/permissions.ts` is a separate concern — it owns the per-session allow/deny/prompt state machine (`allow-once` / `allow-always` / `deny`, plus the WebFetch domain whitelist) and the runtime bash-rule policy. Plan-mode-queued calls still flow through that same approval UI when the user reviews the queue; plan mode just changes the default for non-`read-only` tools from "prompt" to "queue".

## Consequences

**Easier.**

- Adding a new tool requires declaring its `category` once. Omitting the field is a type error, not a runtime escape.
- Plan mode and normal mode share the same approval UI for the queued calls, so a user who flips between modes gets consistent UX.
- Investigations (`/plan` then explore freely) cost the user zero prompts; the cost shows up only at the moment of action.

**Harder.**

- Tools that are *mostly* read-only but can mutate (a future analyzer that writes a cache file, a Bash command that happens to be `ls`) are a category boundary problem. Solve at the tool layer — split the tool, or treat the whole tool as `write`/`execute` — rather than adding per-call conditional logic in the gate.
- MCP tools come from external servers and their read-only/mutating nature is not known statically. The current adapter labels every MCP tool as `execute`, which is the safe default; a future manifest-driven opt-in to `read-only` is a possible follow-up but not implemented today.

**Invariants future contributors must preserve.**

- Tool handlers do not implement plan-mode logic. They declare their `category`; `run-tool-calls-execute.ts` decides whether they run under `--plan`.
- The default for a new tool is *not* `read-only`. Declaring a new tool `read-only` requires explicit justification in review.
- Plan mode never silently downgrades — if the user is in plan mode and a non-`read-only` call arrives, the call is queued, never executed-and-undone.
