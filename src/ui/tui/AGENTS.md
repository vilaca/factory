# ui/tui — orientation

The React + Ink TUI. Two-tab-aware REPL that consumes `AgentEvent` streams from `core/agent/run-agent.ts`. The sibling `src/ui/headless.ts` is the non-TTY render target — it consumes the same events but emits stdout/stderr + process exit codes.

## Public entry

- `renderApp(opts)` (`index.tsx`) — Ink mount. Called from `src/index.ts` when `isInteractiveTty`. Returns an `app` with `waitUntilExit()`.
- `Session` component (`Session.tsx`) — one tab's REPL. Owns no agent state itself; everything flows through `useAgentLoop`.
- `App` component (`App.tsx`) — tab host. F1–F12 / Ctrl+T/W/N/P bindings live here.

## Files

- `index.tsx` — `renderApp` (Ink mount).
- `App.tsx` — tab host (`TabsProvider`, F-key + Ctrl+T/W/N/P hotkeys).
- `Session.tsx` — one tab. Mounts `useAgentLoop`, renders header / conversation / status bar / permission panel / plan panel / input.
- `types.ts` — `DisplayItem`, `ToolCallSummary`, view-model shapes the renderer consumes.
- `format.ts` — small assistant-text formatting helpers.
- `agent-loop/` — the React-hook orchestrator + its pure helpers. See `agent-loop/AGENTS.md`.
- `slash/` — `/command` registry. See `slash/AGENTS.md`.
- `components/` — Ink components (status bar, conversation display, permission panel, plan-approval panel, rotation prompt, provider picker, text input).
- `hooks/` — small React hooks (`use-rotation-fallback`, `use-session-input`, `use-compaction-picker`).
- `tabs/` — tab registry / context (`tabs-registry.ts`, `TabsContext.tsx`, `use-tabs.ts`).

## What runs where

| Concern                                                         | Lives in                                           |
| --------------------------------------------------------------- | -------------------------------------------------- |
| Agent state (conversation, refs, run state)                     | `agent-loop/use-agent-loop.ts` + `RunRefs`         |
| Per-event UI mutation                                           | `agent-loop/event-handler.ts`                      |
| Drive one turn (event pump)                                     | `agent-loop/run-loop.ts`                           |
| Provider / model swap                                           | `agent-loop/swap.ts`                               |
| Session bootstrap (refs, conversation, context manager, logger) | `agent-loop/setup.ts` + `agent-loop/init.ts`       |
| Slash dispatch                                                  | `slash/dispatch.ts`                                |
| Hotkeys                                                         | `App.tsx` (tab keys), Session input (Ctrl+C / Esc) |

## Invariants enforced in `test/unit/arch/modularity.test.ts`

The UI is the **least privileged** layer. Several arch rules cage it:

- `ui/**` must not depend on `mcp/**`. MCP tools reach the UI only as `ToolHandler`s in the registry.
- `ui/**` must not import concrete provider impls — only `providers/types.ts`, `providers/registry.ts`, `providers/descriptors.ts`, `providers/instrument.ts`, `providers/prime.ts`, `providers/usage.ts`.
- `ui/**` must not import concrete tool handlers — only `tools/types.ts`, `tools/registry.ts`, `tools/index.ts`.
- `ui/**` must not import LLM SDKs (`@anthropic-ai/sdk`, `@huggingface/inference`, `@modelcontextprotocol/sdk`, `ollama`, `google-auth-library`).
- `ui/**` must not import node networking / child-process modules (`node:http`, `node:https`, `node:net`, `node:dgram`, `node:child_process`, or their bare-specifier forms).
- `ui/headless.ts` must not depend on `ui/tui/**` — the headless render is a separate target, not a strip-down of the TUI.

If you find yourself wanting to bypass any of these, the right move is usually to add a helper to `providers/`, `tools/`, or `mcp/` and have the UI call that.

## TokenUsage gotcha (44aeb26 contract)

`status-bar.tsx` must read `TokenUsage` only via `contextFillTokens(usage)` from `providers/usage.ts`. Naming `usage.totalTokens` / `usage.completionTokens` / `usage.reasoningTokens` literally is a compile-test failure. The 44aeb26 commit explains why.

## Shared renderers (across TUI + headless)

`describeRotationReason`, `fingerprintLabel`, `formatHookDisplay` live in `src/ui/agent-events/render.ts` and are imported by both TUI and headless. The arch test forbids any other file from declaring those names. If you need a new shared event-render helper, add it there.

## Don't

- **Don't `process.cwd()` in a component.** Use the per-tab `cwd` from `RunRefs` / `AgentLoopApi.cwd`. Two tabs would otherwise fight over the global.
- **Don't subscribe to `process.stdin` outside `App.tsx`.** The F-key tap is intentional and singular; multiple subscribers race.
- **Don't add a new top-level top-down state field.** Per-tab state goes on `RunRefs`. Per-render React state goes through `useAgentLoop` and is exposed via `AgentLoopApi`.
- **Don't add a `useState` for something already on `RunRefs`** — `RunRefs` is the source of truth that survives a tab swap; mirrored React state goes stale.
- **Don't bypass the arch fences** by adding to their `except` lists without a strong reason and a comment naming the rationale.
