# Architecture

This document maps factory's internals so a new contributor can locate the right module quickly.

## High level

```
┌──────────┐   ┌────────────┐   ┌──────┐   ┌──────────┐   ┌───────────┐
│ CLI args │ → │ loadConfig │ → │ auth │ → │ provider │ → │ tools/MCP │
└──────────┘   └────────────┘   └──────┘   └──────────┘   └─────┬─────┘
                                                                │
                                                                ▼
                                                ┌──────────────────────────────┐
                                                │  TUI: renderApp → Session    │
                                                │  no TTY: runHeadless         │
                                                └───────────────┬──────────────┘
                                                                │
                                                                ▼
                                                      ┌──────────────────┐
                                                      │    agent loop    │
                                                      │   (core/agent)   │
                                                      └──────────────────┘
```

The entry in `src/index.ts` parses CLI flags, loads config, runs auth, picks a provider, registers tools, attaches MCP servers, then dispatches to either `renderApp` (TUI) or `runHeadless` (scripted/non-TTY) — both eventually call into the same agent loop.

## Module map

### `src/index.ts`
Top-level `main()`. Parses argv, applies `--debug`, branches on `--version` / `--help`, loads config, applies rotation overrides, runs auth, wires hooks, registers tools, instantiates the MCP manager, prints the welcome banner, and dispatches to TUI or headless mode. Also installs `SIGINT` / `SIGTERM` / `unhandledRejection` / `uncaughtException` handlers.

### `src/cli/`
- `args.ts` — argv parser (manual, no commander), `printUsage()`, `printVersion()`.
- `auth/` — credential resolution and interactive auth flows:
  - `index.ts` — credential resolution: CLI → env var → config file → interactive prompt. Probes providers in parallel during startup. Returns `StartupCredentials` keyed by provider.
  - `flows.ts` — interactive auth flow helpers used during startup.
- `picker.ts` — line-based interactive provider/model selection.
- `prompts.ts` — Ink-based variant of the picker prompts.
- `parse-rotation.ts` — parses the `--rotate <p:m,p:m>` chain syntax.
- `startup/` — startup orchestration:
  - `phases.ts` — per-phase functions called from `main()`.
  - `config.ts` — pure helpers for rotation/experimental/source decisions.
  - `menu.tsx` — Ink-rendered startup picker.

### `src/core/`
The agent core. **`agent/run-agent.ts`** is the loop: stream model output, parse tool calls, dispatch, append results, loop until `done`. Sibling files under `agent/` split out call/parse/run/compact/correct phases.

- `conversation.ts` — message history with token-cap elision.
- `context-manager.ts` — recency window + summary compaction.
- `system-prompt.ts` — dynamic system prompt generation (project facts, capabilities, tool list).
- `project-facts.ts` — best-effort metadata extraction (cloc counts, README excerpt).
- `tool-call/` — tool-call shape massagers:
  - `text-tool-parser.ts` — fallback recovery from prose.
  - `tool-call-corrector.ts` — LLM-driven correction.
  - `tool-result-format.ts` — sentinel framing + imitation strip.
- `agent/` — call/parse/run/compact phases of the loop:
  - `types.ts` — `AgentEvent`, `AgentOptions`, `RotationOptions`.
  - `provider-errors.ts` — rotation classifier.
  - `provider-retry.ts` — transient retry policy.
- `session-log.ts` — JSONL per-session logging in `~/.factory/sessions/`. Tracks provider auth, tool calls, model changes, errors.
- `key-stats.ts` — per-key request and rate-limit counters.
- `config/` — config file load/merge/save with zod-validated schema.
- `credentials.ts` — multi-key store and migration from older single-key formats.

### `src/providers/`
One module per provider. All implement the `Provider` interface.

- `types.ts` — the `Provider` interface every adapter implements.
- `registry.ts` — maps a provider name to a constructor.
- `descriptors.ts` — per-provider metadata (display label, aliases, env vars, default host).
- `openai/` — shared adapter for the ten-or-so OpenAI-compatible providers; owns SSE parsing, streaming chunk handling, tool-call accumulation, and usage extraction.

Native-protocol providers (Anthropic, Ollama, HuggingFace, Cohere, Google AI Studio) parse their own response shapes.

### `src/tools/`
Built-in tools plus the registry that exposes them. Each tool implements `ToolHandler` with a `definition` (LLM-facing JSON schema) and an `execute` that returns a `ToolResult`.

- `read.ts` — file read with byte-range and line-range support.
- `write.ts` — atomic file write.
- `edit.ts` — string-replace edit with read-before-write check.
- `bash.ts` — sandboxed shell execution.
- `glob.ts` — glob-based file listing.
- `grep.ts` — content search.
- `web-fetch.ts` — HTTP fetch + HTML→Markdown extraction.
- `delegate.ts` — delegates to a sub-agent when the experimental `subagents` flag is on.
- `registry.ts` — maps tool name to handler; `ToolRegistry` registers each built-in.
- `index.ts` — exports the shared `defaultRegistry` instance.
- `types.ts` — `ToolHandler`, `ToolDefinition`, `ToolResult` shapes.
- `web/` — HTTP fetch + HTML rendering pipeline backing `web-fetch.ts`:
  - `fetch.ts` — HTTP client with content-type sniffing.
  - `html-to-markdown.ts` — DOM walker that emits Markdown.
  - `html-render.ts` — top-level renderer entry.
  - `html-tokenize.ts` — lightweight HTML tokenizer.

Tool execution is gated by `src/security/permissions.ts` (allow-once / allow-always / deny / domain whitelist) and the security policies in `src/security/` (path jail, env scrubbing, bash rule matching).

### `src/security/`
- `paths.ts` — symlink-aware path jail with built-in deny list (`.ssh`, `.aws`, `.gnupg`, `/etc/shadow`, etc.) and user-configurable rules.
- `bash-rules.ts` — built-in forbidden patterns (`rm -rf /`, fork bomb, `curl|sh`, `dd to /dev/*`) plus user globs. Built-ins cannot be overridden.
- `env.ts` — deny-by-default env scrubbing with a small safe-vars whitelist.

### `src/ui/`
Two render targets: the React + Ink TUI under `ink/`, and the non-TTY `headless.ts`. Both paths call into the same `core/agent/run-agent.ts` loop.

`ink/`:
- `App.tsx` — tab host.
- `Session.tsx` — one tab's REPL.
- `use-agent-loop.ts` — React hook that drives the loop.
- `agent-loop/` — DI'd helpers (init, history, run-loop, event-handler).
- `slash/` — user-typed slash commands; `dispatch.ts` is the entry, individual handlers live alongside.
- `tabs/` — tab registry/context.

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

## Data flow: one user prompt → one response

1. User types into the input bar in `Session.tsx`.
2. `Session.tsx:handleSubmit` dispatches: slash commands go to `dispatchSlashCommand`; plain text becomes `agent.queueInput(text)` on the `useAgentLoop` API.
3. `use-agent-loop.ts` queues the message into a `Conversation` (from `core/conversation.ts`), then calls into `core/agent/run-agent.ts:runAgent`.
4. `runAgent` builds the system prompt via `system-prompt.ts`, applies cache boundaries via `agent/cache-boundaries.ts`, then calls `agent/call-model.ts:callModel` which streams from the provider.
5. The provider's `chat()` method yields `ChatChunk`s — content deltas, tool calls, and a final `done: true` with usage. `runAgent` consumes these and emits `AgentEvent`s.
6. Events flow back to `use-agent-loop.ts` → `agent-loop/event-handler.ts:handleAgentEvent`, which mutates streaming state and the display item list.
7. When the model emits `tool_calls`, `agent/run-tool-calls.ts` is invoked: each call is permission-checked (`src/security/permissions.ts`), security-checked (`src/security/`), executed, and the result appended to the conversation as a `tool` message.
8. The loop repeats until the model returns `done: true` without tool calls, or until the turn timeout triggers.
9. `session-log.ts` writes JSONL events throughout (start, model-changes, tool-call, tool-call-result, turn-complete, errors).

## Permission and security layering

```
user input → slash dispatcher ─┐
                               ├─→ tool execute()
agent tool_call → permissions ─┘       │
                                       ▼
                       security/{paths, bash-rules, env}
                                       │
                                       ▼
                                   actual I/O
```

`src/security/permissions.ts` decides per-tool / per-domain whether a call needs interactive approval. `src/security/` checks the *content* of the call: paths must pass the jail, bash commands must not match a forbidden pattern, env vars passed to spawned shells are scrubbed against the deny list. Both layers must approve before execution.

Built-in security rules cannot be overridden by user config — only extended.

## Build & distribution

- Source: `src/` → `dist/` via `tsc` (Node16 module, ES2022 target, declaration maps).
- Entry: `dist/index.js` ships with a `#!/usr/bin/env node` shebang.
- `package.json:bin.factory` makes `factory` available globally after `npm install -g` or `npm link`.
- `package.json:files` allowlists `dist`, `README.md`, `LICENSE` for the npm tarball; `.npmignore` is defense-in-depth.
- Tests compile separately to `dist-test/` via `tsconfig.test.json`.

## Where to start when adding...

| Change | Touch |
|--------|-------|
| New CLI flag | `src/cli/args.ts` (parser + usage) → `src/index.ts` (apply) |
| New provider | `src/providers/<name>.ts` + `descriptors.ts` + `registry.ts` (see [CONTRIBUTING.md](CONTRIBUTING.md)) |
| New tool | `src/tools/<name>.ts` + `src/tools/registry.ts` (register in `ToolRegistry`) |
| New slash command | `src/ui/ink/slash/<name>.ts` + `src/ui/ink/slash/dispatch.ts` (dispatcher) |
| New session-log event | `src/core/session-log.ts:logXxx` + corresponding caller |
| New security rule | `src/security/<area>.ts` — built-in rules are an export list |
