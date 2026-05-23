# 0016 — MCP servers wrapped as `ToolHandler`s in the shared registry

- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

The Model Context Protocol gives the agent access to tools running in external processes (filesystem servers, GitHub, browsers, etc.). The temptation is to give MCP a parallel dispatch path: its own permission flow, its own session-log shape, its own security checks. That path quickly diverges — MCP tools end up with weaker or stronger checks than built-ins for no principled reason, and bugs fixed in one path don't fix the other.

The built-in tool surface (`ToolHandler` interface in `src/tools/types.ts`) already encodes everything an external tool needs: definition (JSON-schema-shaped), execute (returns a `ToolResult`), permission category, mutating/read-only flag.

## Decision

`src/mcp/adapter.ts` wraps every remote MCP tool as a `ToolHandler` and registers it into the same `ToolRegistry` (`src/tools/registry.ts`) as the built-ins. From the agent loop's perspective, an MCP tool is indistinguishable from a built-in: same dispatch, same `permissions.ts` gate, same `paths.ts` / `bash-rules.ts` checks where applicable, same session-log events, same correction-loop behavior. The MCP client (`src/mcp/client.ts`) owns process lifecycle and transport; the adapter owns the interface translation.

## Consequences

**Easier.**

- Adding MCP support to a new feature (a new permission flag, a new resilience layer) costs zero — it inherits from the shared dispatch.
- Security audits cover both surfaces by inspecting one. The path jail applies to MCP filesystem tools by construction.
- Session logs treat MCP and built-in tool calls uniformly; one `/stats` query answers across both.

**Harder.**

- MCP tools come with schemas of varying quality. The adapter has to be tolerant of underspecified schemas without weakening the `ToolHandler` contract for built-ins. Conservative default: every MCP tool is registered with `category: 'execute'` (see `src/mcp/adapter.ts`), which means plan mode queues them and they prompt under normal mode. There is no manifest-driven opt-in to `'read-only'` today; that's a possible follow-up but explicitly not implemented.
- A misbehaving MCP server can crash its child process; the client must restart it without disturbing the agent loop. That's a `client.ts` concern, not an adapter concern — the boundary is the right place to absorb the failure.

**Invariants future contributors must preserve.**

- MCP tools never bypass `permissions.ts` or `src/security/`. If they appear to, that's an adapter bug.
- The `ToolHandler` interface is the contract. Adding MCP-specific fields to it (e.g. "this is from MCP") is a smell — the registry shouldn't care.
- Process lifecycle stays in `client.ts`. The adapter handles one tool call at a time and is stateless.
