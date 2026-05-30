# Architecture

This document maps factory's internals so a new contributor can locate the right module quickly.

## High level

```mermaid
flowchart LR
  A[CLI args] --> B[loadConfig] --> C[auth] --> D[provider] --> E[tools / MCP]
  E --> F{isInteractiveTty}
  F -- yes --> G[renderApp — TUI]
  F -- no  --> H[runHeadless]
  G --> I[agent loop<br/>core/agent]
  H --> I
```

The entry in `src/index.ts` parses CLI flags, loads config, runs auth, picks a provider, registers tools, attaches MCP servers, then checks `isInteractiveTty` and dispatches to either `renderApp` (TUI) or `runHeadless` (scripted/non-TTY) — both eventually call into the same agent loop.

## Module map

### `src/index.ts`

Top-level `main()`. Parses argv, applies `--debug`, branches on `--version` / `--help`, loads config, applies rotation overrides, runs auth, wires hooks, registers tools, instantiates the `McpManager` (`src/mcp/client.ts`), prints the welcome banner, and dispatches to TUI or headless mode based on `isInteractiveTty`. Also installs `unhandledRejection` / `uncaughtException` handlers.

### `src/cli/`

- `args.ts` — argv parser (manual, no commander), `printUsage()`, `printVersion()`.
- `picker.ts` — line-based interactive provider/model selection.
- `prompts.ts` — Ink-based variant of the picker prompts.
- `auth/` — credential resolution and interactive auth flows (storage and model validation live in `src/core/auth/`):
  - `index.ts` — credential resolution: CLI → env var → config file → interactive prompt. Probes providers in parallel during startup. Returns `StartupCredentials` keyed by provider.
  - `flows.ts` — interactive auth flow helpers used during startup.
- `startup/` — startup orchestration:
  - `phases.ts` — per-phase functions called from `main()`.
  - `config.ts` — pure helpers for rotation/experimental/source decisions.
  - `menu.tsx` — Ink-rendered startup picker host (display + commit/cancel wiring).
  - `picker-data.ts` — startup picker data source (fetch models/keys, validate key, persist key).
  - `parse-rotation.ts` — parses the `--rotate <p:m,p:m>` chain syntax.

### `src/core/`

The agent core. **`agent/run-agent.ts`** is the turn orchestrator: append user input, pre-flight compact, call/stream the model, parse/sanitize output, execute tool calls, and re-enter the loop until a terminal `turn-complete` stop reason (`completed`, `user-abort`, `token-limit`, or `error`). The `StopReason` union in `types.ts` also includes `turn-limit` (e.g. subagent runners); the main `runAgent` generator does not emit that value. Sibling files under `agent/` split the loop into call/parse/run/compact/recover phases.

- `agent/` — the loop and its phases:
  - `run-agent.ts` — the top-level async generator; orchestrates one turn end-to-end.
  - `parse-response.ts` — content + tool-call extraction (with text-fallback recovery).
  - `compaction.ts` — invokes the context manager when the budget is hit.
  - `recovery-state.ts` — per-run counters for replay and token-limit retries.
  - `types.ts` — `AgentEvent`, `AgentOptions`, `RotationOptions`.
  - `cache/` — read-cache + cache-boundary helpers:
    - `file-cache.ts` — Read-tool dedup (mtime + lazy hash) plus compaction-summary fingerprints.
    - `cache-boundaries.ts` — provider cache-boundary placement for system prompt + history.
  - `call-model/` — provider invocation wrapper:
    - `call-model.ts` — entry that delegates to retry/rotation helpers and returns a chunk stream.
    - `call-model-retry.ts` — transient retry policy.
    - `call-model-rotation.ts` — fail-over across rotation chain on rate-limit/auth.
    - `provider-errors.ts` — rotation classifier.
    - `provider-retry.ts` — low-level retry-with-backoff primitive.
    - `repeat-detector.ts` — detects model output loops and aborts the turn.
    - `weak-tier.ts` — picks a cheaper model for the corrector sub-call.
  - `tool-calls/` — tool-call processing (parsing, correction, dispatch, execution):
    - `run-tool-calls.ts` — top-level dispatcher; permission/security gate + correction loop.
    - `run-tool-calls-execute.ts` — executes one approved call and records the result.
    - `run-tool-calls-cache.ts` — cache-hit short-circuit for repeat Read calls.
    - `bash-dedup.ts` — fires a one-shot nudge when the model spins on near-duplicate Bash calls.
    - `text-tool-parser.ts` — fallback parser for prose-embedded tool calls.
    - `tool-call-corrector.ts` — LLM-driven correction of malformed calls.
    - `tool-result-format.ts` — sentinel framing + imitation strip.
- `context/` — conversation state passed to the model:
  - `conversation.ts` — message history with token-cap elision.
  - `context-manager.ts` — recency window + summary compaction.
  - `system-prompt.ts` — dynamic system prompt generation (project facts, capabilities, tool list).
  - `project-facts.ts` — best-effort metadata extraction (cloc counts, README excerpt).
- `auth/` — credential storage (interactive resolution lives in `src/cli/auth/`):
  - `credentials.ts` — multi-key store and migration from older single-key formats.
  - `model-validation.ts` — model-id sanity checks at startup. Lives under `auth/` for historical reasons but is about provider model IDs, not credentials.
- `config/` — config file load/merge/save with zod-validated schema (`index.ts`, `merge.ts`, `types.ts`, `validate.ts`).
- `session/` — per-session telemetry:
  - `session-log.ts` — JSONL per-session logging in `~/.factory/sessions/`. Tracks provider auth, tool calls, model changes, errors.
  - `key-stats.ts` — per-key request and rate-limit counters.
- `hooks/` — user-configured shell hooks:
  - `index.ts` — hook executor (sandboxed env, forbidden-command guard).
  - `discovery.ts` — resolve hook entries by event + tool/matcher.
  - `trust.ts` — first-run trust prompts for new hook scripts.
- `skills/` — experimental conditional skills:
  - `loader.ts` — discover skill files and parse their headers.
  - `matcher.ts` — match-on-path / match-on-text rules.
  - `index.ts` — `SkillsRegistry` (in-memory, dedupes injections).
- `subagent/` — experimental delegation target:
  - `runner.ts` — runs a sub-agent loop with its own conversation and tool registry.
  - `bash-allowlist.ts` — restricted Bash policy for sub-agents.

### `src/providers/`

All providers implement the `Provider` interface. The shared `openai/` folder is an internal adapter (no registry entry of its own) that owns SSE parsing, streaming chunk handling, tool-call accumulation, and usage extraction; most providers delegate to it via `buildChatBody` / `sendOpenAiChat` / `streamOpenAiChat`.

Three flavors:

1. **Flat-file consumers of the shared adapter** — `cerebras.ts`, `groq.ts`, `mistral.ts`, `openrouter.ts`, `vercel.ts`, `llamacpp.ts`, `workersai.ts` are single files that delegate streaming and tool-call handling to `openai/`. `huggingface.ts` reuses only the tool-call helpers (its transport is the `@huggingface/inference` SDK).
2. **Folder-with-own-auth on the shared adapter** — `copilot/` and `googleaistudio/` use `openai/` for transport but carry their own auth flow alongside; `opencodezen/` is a proxy folder that re-exposes Anthropic/Google through a single OpenAI-compatible endpoint.
3. **Truly native** — `anthropic.ts` (uses `@anthropic-ai/sdk`), `ollama.ts` (uses the `ollama` package), and `cohere.ts` (hand-rolled) parse their own response shapes and don't touch `openai/`.

Cross-cutting files:

- `types.ts` — the `Provider` interface every adapter implements.
- `registry.ts` — maps a provider name to a constructor (no `openai` entry — the adapter is internal).
- `descriptors.ts` — per-provider metadata (display label, aliases, env vars, default host).

### `src/tools/`

Built-in tools plus the registry that exposes them. Each tool implements `ToolHandler` with a `definition` (LLM-facing JSON schema) and an `execute` that returns a `ToolResult`.

- `read.ts` — file read with byte-range and line-range support.
- `write.ts` — atomic file write.
- `edit.ts` — string-replace edit with read-before-write check.
- `bash.ts` — sandboxed shell execution.
- `glob.ts` — glob-based file listing.
- `grep.ts` — content search.
- `delegate.ts` — delegates to a sub-agent when the experimental `subagents` flag is on.
- `registry.ts` — maps tool name to handler; `ToolRegistry` registers each built-in.
- `index.ts` — exports the shared `defaultRegistry` instance.
- `types.ts` — `ToolHandler`, `ToolDefinition`, `ToolResult` shapes.
- `web/` — HTTP fetch + HTML rendering pipeline backing the WebFetch tool. The pipeline is:

  ```
  fetch.ts → html-tokenize.ts → html-render.ts → html-to-markdown.ts
  ```

  - `index.ts` — the `WebFetch` tool handler.
  - `fetch.ts` — HTTP client with content-type sniffing.
  - `html-tokenize.ts` — lightweight HTML tokenizer.
  - `html-render.ts` — top-level renderer entry.
  - `html-to-markdown.ts` — DOM walker that emits Markdown.

Tool execution is gated by `src/security/permissions.ts` (allow-once / allow-always / deny / domain whitelist) and the security policies in `src/security/` (path jail, env scrubbing, bash rule matching).

### `src/security/`

- `permissions.ts` — per-tool / per-domain interactive approval state machine.
- `paths.ts` — symlink-aware path jail with built-in deny list (`.ssh`, `.aws`, `.gnupg`, `/etc/shadow`, etc.) and user-configurable rules.
- `bash-rules.ts` — built-in forbidden patterns (`rm -rf /`, fork bomb, `curl|sh`, `dd to /dev/*`) plus user globs. Built-ins cannot be overridden.
- `env.ts` — deny-by-default env scrubbing with a small safe-vars whitelist.

### `src/ui/`

Two render targets: the React + Ink TUI under `tui/`, and the non-TTY `headless.ts`. Both paths call into the same `core/agent/run-agent.ts` loop.

`tui/`:

- `index.tsx` — `renderApp()` entry.
- `App.tsx` — tab host.
- `Session.tsx` — one tab's REPL.
- `format.ts` — assistant-text formatting helpers (used by the renderer).
- `types.ts` — `DisplayItem`, `ToolCallSummary`, and other view-model types.
- `agent-loop/` — DI'd helpers around the React hook that drives the loop:
  - `use-agent-loop.ts` — the orchestrator hook itself.
  - `init.ts`, `setup.ts`, `swap.ts` — session bootstrap and provider/model swap.
  - `run-loop.ts` — drives one turn, consumes `AgentEvent`s.
  - `event-handler.ts` — maps `AgentEvent` → display-item / state mutations.
  - `history.ts` — input history stack.
  - `git-state.ts` — branch + dirty refresh.
  - `compose-system-prompt.ts` — per-turn system prompt composition.
  - `agent-loop-types.ts` — `RunRefs`, `AgentLoopApi`, `AgentLoopDeps` shapes.
- `components/` — Ink components (status bar, conversation display, permission panel, plan-approval panel, rotation prompt, etc.).
  - `provider-picker/` — shared picker used at startup and mid-session (`/pick`, `Ctrl+K`) with explicit layer split:
    - `index.tsx` — top-level component state + hook wiring.
    - `render-body.tsx` + `stages.tsx` — display layer (stage-specific rendering).
    - `prepare.ts` — preparation layer (model ranking/sorting for display).
    - `data-actions.ts` — data/controller layer (async key/model fetch + stage transitions).
    - `stage-key-handlers.ts` — keyboard behavior layer (per-stage key dispatch).
    - `keys.ts` — input hook wiring that delegates to the above layers.
- `slash/` — user-typed slash commands; `dispatch.ts` is the entry, individual handlers live alongside (`hooks.ts`, `keys.ts`, `rotate.ts`, `rotate-helpers.ts`, `rotate-subcommands.ts`, `stats.ts`).
- `hooks/` — small React hooks (`use-rotation-fallback.ts`, `use-session-input.ts`).
- `tabs/` — tab registry/context (`tabs-registry.ts`, `TabsContext.tsx`, `use-tabs.ts`).

Top-level files:

- `headless.ts` — non-TTY entry point used for scripted runs and CI. Reads from stdin, writes to stdout, no Ink.
- `renderer.ts` — markdown-to-terminal pipeline (marked + marked-terminal, with a patch for inline-token rendering and a guard against unsupported highlight.js languages).

### `src/mcp/`

Model Context Protocol integration.

- `client.ts` — connects to external MCP servers as child processes.
- `adapter.ts` — wraps each remote tool as a `ToolHandler` so they slot into the same registry as built-in tools.
- `types.ts` — shared MCP types.

### `src/utils/`

Small helpers.

- `errors.ts` — extract `error.message`.
- `git.ts` — branch / dirty detection.
- `tokens.ts` — `CHARS_PER_TOKEN` constant + estimator.
- `glob-match.ts` — POSIX-glob to regex.
- `atomic-write.ts` — write-then-rename file write.
- `json-extract.ts` — extract JSON from prose.
- `build-info.ts` — build metadata loader.
- `debug.ts` — debug logging gate.
- `timeout.ts` — promise timeout helper.

## Build & distribution

- Source: `src/` → `dist/` via `tsc` (Node16 module, ES2022 target, declaration maps).
- Entry: `dist/index.js` ships with a `#!/usr/bin/env node` shebang.
- `package.json:bin.factory` makes `factory` available globally after `npm install -g` or `npm link`.
- `package.json:files` allowlists `dist`, `README.md`, `LICENSE` for the npm tarball; `.npmignore` is defense-in-depth.
- Ambient declarations live in `src/globals.d.ts` (e.g. `marked-terminal` typings).
- Unit tests run directly against TS source via `tsx --test 'test/unit/**/*.test.ts'` (no compile step). Unit tests mirror `src/` under `test/unit/`.
- End-to-end tests compile both `src/` and `test/` into `dist-test/` via `tsconfig.test.json` and run with `node --test`. The harness lives at the top of `test/`: `e2e-mocks.test.ts` and `e2e-no-mocks.test.ts` are the suites, `cli-harness.ts` spawns the built binary, and `mock-copilot-server.ts` / `mock-ollama-server.ts` stub provider endpoints.

## Data flow: one user prompt → one response

1. User submits input in `Session.tsx`.
2. `useSessionInput` routes slash commands to `dispatchSlashCommand`; plain text reaches `run-loop.ts:processInput` via the `useAgentLoop` API (session log + UI item + optional skill injection, then the loop driver).
3. `run-loop.ts:runAgentLoopInternal` sets per-turn runtime refs (abort controller, timeout, mutable `cwdRef`, responses-chain adapter, rotation context) and calls `core/agent/run-agent.ts:runAgent`.
4. `runAgent` appends the user message to `Conversation`, fires `UserPromptSubmit` hook (optional), then enters `while (true)`.
5. Each loop iteration does pre-flight compaction (`maybeCompact`), emits `pre-turn-stats` when a `contextManager` is present, then calls `call-model.ts:callModel`.
6. `callModel` streams provider `ChatChunk`s into `text-chunk` events, handles retry/rotation, and returns final text/tool calls/usage metadata.
7. `runAgent` parses/sanitizes response text (`parse-response.ts`), emits `text-done`, stores assistant content, and either:
   - completes the turn if no tool calls, or
   - runs `tool-calls/run-tool-calls.ts` (permissions/security/hooks/execution/corrector), appends tool results to conversation, and loops again so the model can react.
8. The turn exits only via `turn-complete` with stop reason `completed`, `user-abort`, `token-limit`, or `error` from this generator (`turn-limit` is reserved for other runners — see `StopReason` in `types.ts`).
9. In TUI mode, `event-handler.ts` consumes each `AgentEvent` and mutates UI state; in headless mode, `src/ui/headless.ts` consumes the same events and renders stdout/stderr + process exit codes.
10. `core/session/session-log.ts` records JSONL telemetry throughout (turn/model/tool/hook/rotation events).

## AgentEvent lifecycle and UI state transitions

`AgentEvent` is the contract between the core loop (`core/agent`) and renderers (`ui/tui`, `ui/headless`).

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant T as TUI/Headless driver
  participant R as runAgent
  participant M as callModel
  participant X as runToolCalls

  U->>T: submit prompt
  T->>R: runAgent(userInput, options)
  loop turn loop (while true)
    R->>R: maybeCompact + pre-turn-stats
    R->>M: callModel(messages, tools)
    M-->>R: text-chunk* / retries / rotations
    R-->>T: AgentEvent stream
    R->>R: parseModelResponse + text-done
    alt tool calls present
      R->>X: runToolCalls(toolCalls)
      X-->>R: tool-call-* / permission-request / hook-*
      R-->>T: AgentEvent stream
    else no tool calls
      R-->>T: turn-complete(completed)
    end
  end
```

Typical sequence for one successful turn:

1. `text-chunk` (0..N)
2. `text-done` (if any text)
3. `tool-call-start` → optional `permission-request` → `tool-call-result` / `tool-call-denied` (0..N calls)
4. repeat model + tool phases as needed
5. `turn-complete`

Important event families (full union: `AgentEvent` in `core/agent/types.ts`):

- **Context/control:** `compaction-start`, `compaction`, `pre-turn-stats` (only with a context manager), `turn-complete`, `error`
- **Model transport:** `provider-retry`, `key-rotation`, `key-rotation-exhausted`, `tuple-rotation`, `tuple-rotation-exhausted`, `repetition-detected`
- **Permissions:** `permission-request` (interactive approval before a gated tool runs)
- **Tool calls:** `tool-call-start`, `tool-call-result`, `tool-call-denied`, `tool-call-planned`, `tool-call-recovered`, `tool-call-corrected`, `tool-call-corrector-aborted`, `all-denied-halt`, `bash-dedup-nudge`
- **Recovery/safety:** `auto-retry-injected`, `auto-retry-exhausted`, `tool-result-imitation-stripped`, `output-cap-reached`, `empty-turn-warning`
- **Hooks/cache:** `hook-fired`, `hook-error`, `hook-veto`, `read-cache-hit`

TUI run-state transitions (`agent-loop/event-handler.ts`):

- `idle` → `running` on prompt submission.
- `running` → `awaiting-permission` on `permission-request`.
- `awaiting-permission` → `running` after user decision resolves.
- turn-finalization path resets transient activity labels (`retrying…`, `rotating…`) and returns to idle at loop end.

Headless consumes the same events but maps them to stderr notices and exit codes (`error`→1, `token-limit`→5, non-TTY permission block→3).

## Permission and security layering

```mermaid
flowchart TB
  A[user input] --> B[slash dispatcher]
  C[agent tool_call] --> D[permissions]
  B --> E["tool execute()"]
  D --> E
  E --> F["security/{paths, bash-rules, env}"]
  F --> G[actual I/O]
```

`src/security/permissions.ts` decides per-tool / per-domain whether a call needs interactive approval. `src/security/` checks the _content_ of the call: paths must pass the jail, bash commands must not match a forbidden pattern, env vars passed to spawned shells are scrubbed against the deny list. Both layers must approve before execution.

Built-in security rules cannot be overridden by user config — only extended.

## Where to start when adding...

| Change                | Touch                                                                                                                                                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New CLI flag          | `src/cli/args.ts` (parser + usage) → `src/index.ts` (apply)                                                                                                                                                                                                                                     |
| New provider          | `src/providers/<name>.ts` (or folder) + `descriptors.ts` + `registry.ts`. For OpenAI-compatible APIs, delegate transport to `./openai/index.js` (`buildChatBody`, `sendOpenAiChat`, `streamOpenAiChat`) — see `vercel.ts` or `groq.ts` as a template. (See [CONTRIBUTING.md](CONTRIBUTING.md).) |
| New tool              | `src/tools/<name>.ts` + `src/tools/registry.ts` (register in `ToolRegistry`)                                                                                                                                                                                                                    |
| New slash command     | `src/ui/tui/slash/<name>.ts` + `src/ui/tui/slash/dispatch.ts` (dispatcher)                                                                                                                                                                                                                      |
| New session-log event | add a method on the `SessionLogger` interface in `src/core/session/session-log.ts` (alongside `logModelChange`, `logToolCall`, etc.) + call it from where the event fires                                                                                                                       |
| New security rule     | `src/security/<area>.ts` — built-in rules are an export list                                                                                                                                                                                                                                    |
| New hook event        | `src/core/hooks/discovery.ts` (event enum) + caller (where the hook fires)                                                                                                                                                                                                                      |
| New skill matcher     | `src/core/skills/matcher.ts`                                                                                                                                                                                                                                                                    |
