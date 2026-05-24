# mcp — orientation

Model Context Protocol client. Connects to external MCP servers as child processes and adapts their advertised tools so they slot into the same `ToolRegistry` as built-in tools.

## Public entry

- `McpManager` (`client.ts`) — owns the lifecycle of MCP child processes. `connectAll(configs)` connects every configured server in parallel and returns a flat array of `ToolHandler`s ready to register on the per-session `ToolRegistry`. `disconnect(perServerTimeoutMs)` bounds shutdown so a hung server can't hold the process open; returns the list of servers that didn't acknowledge close in time.
- `adaptMcpTool(client, serverName, mcpTool)` (`adapter.ts`) — wraps a single remote MCP tool descriptor as a `ToolHandler`. The wrapper translates the call into a `client.callTool({ name, arguments })` and shapes the response into a `ToolResult`.

## Files

- `client.ts` — `McpManager` class + `McpConnection` internal type. Spawns child processes via `StdioClientTransport`.
- `adapter.ts` — `adaptMcpTool` — the only file allowed to know about the `@modelcontextprotocol/sdk` response shape outside the SDK boundary.
- `types.ts` — `McpServerConfig` (config-file shape used by `core/config/`).

## Lifecycle

1. `src/index.ts` constructs an `McpManager` if `config.mcp?.servers?.length > 0`.
2. `manager.connectAll(servers)` connects them in parallel; failed connections log to stderr and are skipped (other servers still come up).
3. Each adapted tool is registered into the per-session `ToolRegistry`.
4. `installShutdownHandlers` in `cli/startup/phases.ts` calls `manager.disconnect(SHUTDOWN_BUDGET_MS / 2)` on SIGINT / SIGTERM / process exit.

## Invariants enforced in `test/unit/arch/modularity.test.ts`

- `mcp/**` must not depend on `ui/**`. The renderer talks to MCP tools through the same `ToolHandler` surface as built-in tools.
- `ui/**` must not depend on `mcp/**` either. The arch test is symmetric — neither side knows about the other.

## Don't

- **Don't bypass `adaptMcpTool`** by exposing the raw `Client` to other layers. The wrapper is the boundary where MCP-specific failure modes (transport errors, malformed tool responses) become `ToolResult` failures the agent loop already knows how to handle.
- **Don't import `@modelcontextprotocol/sdk` outside `client.ts` / `adapter.ts`.** It's a network-shaped dependency; the UI arch test bans it from `ui/**` explicitly.
- **Don't move `McpManager` construction into a global singleton.** Each session is meant to potentially have its own MCP scope; the per-session registry pattern from `tools/` extends naturally to MCP servers.
- **Don't add an `http` / `sse` transport without first wiring sandboxing.** stdio is the only transport today because the spawned process inherits the path/env policy via `sanitizeEnv` (eventually). An HTTP transport bypasses that gate by definition.
