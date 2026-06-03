# factory — agent orientation

Entry point for AI agents working in this codebase. Read this first, then follow the links to the module you're touching.

## Done means

Before declaring any task complete, all of the following must pass:

```bash
npx tsc --noEmit          # type check
npm run lint              # eslint
npm run test:unit         # fast (~6s), runs arch/modularity checks too
```

For changes that touch the agent loop, tools, or e2e flows, also run:

```bash
npm run test:e2e          # requires a clean build first (tsc runs inside)
```

Coverage is gated at 60% lines / 75% branches / 83% functions. If you add new code, add tests.

## Task routing

| Task | Start here |
|------|------------|
| Add a provider | `src/providers/AGENTS.md` |
| Add or modify a tool | `src/tools/AGENTS.md` |
| Change the agent loop (turn handling, tool execution, compaction) | `src/core/agent/AGENTS.md` |
| Change context / conversation / system prompt | `src/core/context/AGENTS.md` |
| Add a `/slash` command | `src/ui/tui/slash/AGENTS.md` |
| Change TUI components or React state | `src/ui/tui/AGENTS.md` |
| Change how the agent loop drives the TUI | `src/ui/tui/agent-loop/AGENTS.md` |
| Change config loading or schema | `src/core/config/AGENTS.md` |
| Change security rules (path jail, bash deny list, permissions) | `src/security/AGENTS.md` |
| Change MCP client or adapter | `src/mcp/AGENTS.md` |
| Change hooks (user shell hooks) | `src/core/hooks/AGENTS.md` |
| Change session logging or key stats | `src/core/session/AGENTS.md` |
| Change startup / auth / CLI flags | `src/cli/startup/AGENTS.md` |
| Change utils or shared types | `src/utils/AGENTS.md` |

## Module map (one-liner each)

```
src/
  index.ts          — main(); wires everything together, dispatches to TUI or headless
  cli/              — argv parsing, auth flows, startup orchestration, provider picker
  core/             — agent loop, context/conversation, config, auth storage, hooks, skills, session log
  providers/        — LLM adapters (Anthropic, OpenAI-compat, Ollama, Copilot, …)
  tools/            — built-in tools (Read, Write, Edit, Bash, Glob, Grep, WebFetch, Delegate)
  ui/               — TUI (Ink/React) + headless renderer; both consume the same AgentEvent stream
  mcp/              — MCP client and adapter (tools exposed to the model via MCP)
  security/         — path jail, bash deny list, permission state machine, env scrubbing
  utils/            — shared primitives (no imports from sibling top-level folders)
```

## Architecture invariants (enforced by `npm run test:unit`)

All rules are in `test/unit/arch/modularity.test.ts` and documented in `MODULARITY_RULES.md`. The short version:

- `core/` must not import `ui/`, `cli/`, or concrete provider/tool impls.
- `providers/` must not import `ui/`, `tools/`, `core/`, `mcp/`, or `cli/`.
- `ui/` must not import MCP, LLM SDKs, or Node networking modules directly.
- `utils/` must not import any sibling top-level folder.
- `src/providers/openai/` is internal — nothing outside `src/providers/` may import it.
- `@modelcontextprotocol/sdk` is confined to `src/mcp/client.ts` and `src/mcp/adapter.ts`.

Violating these is a CI failure. If you genuinely need cross-layer communication, the right move is almost always adding a helper to `utils/` or extending a seam file — not adding an exception.

## Test layout

```
test/unit/<module>/   — mirrors src/<module>/; one file per source file being tested
test/e2e/             — PTY-harness end-to-end tests
test/fixtures/        — static fixture files
test/mocks/           — shared mock builders
```

Unit tests use Node's built-in `node:test` runner (not Jest/Vitest). E2E tests spawn the compiled binary in a real PTY via `test/cli-harness.ts`.

## Commit convention

Conventional Commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`. One focused commit per concern. The project squash-merges to `main`, so branch history doesn't need to be perfect — but the squash commit message should follow the convention.
