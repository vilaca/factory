# 0006 — `src/mcp/` and `src/ui/` must not import each other

- **Status:** Accepted
- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

MCP integration (`src/mcp/`) is an agent-side concern: it spawns external server processes, translates each remote tool into a `ToolHandler`, and feeds those handlers into the same registry the agent loop uses. The UI is downstream of the registry — it asks "what tools are available?" via typed registry surfaces and renders permission prompts when needed.

Two distinct couplings would break the boundary if allowed:

- `mcp/ → ui/` would mean the MCP layer surfaces its own UI (popups, prompts, status) directly, bypassing the renderer split ([ADR 0021](0021-renderer-split-tui-headless.md)) and the `AgentEvent` contract ([ADR 0011](0011-agent-event-contract.md)). MCP would dictate how it's rendered.
- `ui/ → mcp/` would mean the UI knows about MCP-specific concepts (server lifecycle, protocol messages, child processes) instead of treating MCP tools as `ToolHandler`s like any other. The promise that MCP is invisible to renderers ([ADR 0016](0016-mcp-as-toolhandlers.md)) would silently erode.

Both edges have to be banned for the boundary to hold; banning only one leaves the other free to drift.

## Decision

`src/mcp/**` must not depend on `src/ui/**`, and `src/ui/**` must not depend on `src/mcp/**`. The two folders are isolated in both directions. MCP tools reach the UI by going through the registry (a `ToolHandler` like any other); the UI reaches MCP only by interacting with those tools through the agent loop.

Enforced in `test/unit/arch/modularity.test.ts` via two rules:

- `projectFiles().inFolder('src/mcp/**').shouldNot().dependOnFiles().inFolder('src/ui/**')`
- `projectFiles().inFolder('src/ui/**').shouldNot().dependOnFiles().inFolder('src/mcp/**')`

## Consequences

**Easier.**

- MCP can be unit-tested without an Ink harness; the UI can render tool calls without knowing whether a tool came from MCP.
- An MCP server bug never bleeds into renderer state, and a UI refactor never destabilizes process lifecycle.
- Future renderers (ACP server, headless variants) inherit MCP support automatically because MCP routes through the registry, not through any renderer.

**Harder.**

- An MCP server that wants to surface progress or status to the user does it via `AgentEvent` (a `tool-call-start`/`tool-call-result` event that carries metadata), not via a direct UI call.
- The UI cannot, for instance, show "MCP server `foo` is restarting" without the agent loop emitting a corresponding event. That's the right place to put such a feature — in the event contract, not as a cross-folder import.

**Invariants future contributors must preserve.**

- Both ArchUnit rules stay. Removing one would silently let drift accumulate in the opposite direction.
- MCP-specific UI affordances (custom progress, server status) belong in the event union and are rendered by both `tui/` and `headless.ts` uniformly. There is no MCP-only renderer path.
