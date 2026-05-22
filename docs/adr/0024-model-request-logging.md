# 0024 — Outgoing LLM payloads logged in full to the session JSONL

- **Status:** Accepted
- **Date:** 2026-05-23
- **Supersedes:** —
- **Superseded-by:** —

## Context

ADR 0017 made the JSONL session log the authoritative observability surface for user input and agent events, and ADR 0023 closed the gap that errors and warnings were silently bypassing it. What remained missing was the actual outgoing payload to the LLM — system prompt + accumulated conversation + tool definitions + per-call options, exactly as handed to the provider. Without that, a post-mortem can't see what the model was given, only what it produced.

The same provider instance is reused by four subsystems: the main agent turn, the tool-call corrector (`tool-calls/tool-call-corrector.ts`), the compaction summarizer (`context/context-manager.ts`), and the subagent runner (`subagent/runner.ts`, via the spawned conversation). A wrap-time `defaultSource` tag is therefore insufficient — calls from the corrector or compaction on the same wrapped instance would mis-bucket as the parent's source.

## Decision

Wrap each session-scoped `Provider` with `instrumentProviderRequests` (`src/providers/instrument.ts`). The decorator fires `onRequest(info)` before delegating to `chat` / `chatNoStream`; the host (TUI `createInitialRefs` + post-swap + rotation builder; headless top-of-run + compaction resolver) wires `onRequest` to `SessionLogger.logModelRequest`, producing one `type: 'model-request'` row per outgoing call. The row carries:

- `provider`, `model` — the resolved tuple actually used
- `streaming` — `chat` vs `chatNoStream`
- `messages`, `tools`, `options` — the verbatim arguments
- `source` — one of `main` / `compaction` / `corrector` / `subagent`

`source` is resolved per call: `ChatOptions._requestSource` (set by the corrector and compaction summarizer) overrides the wrapper's `defaultSource` when present. The underscore prefix flags it as logging metadata that providers ignore. The session-level wrapper, the post-swap wrapper, and the rotation `withKey` / `withTuple` wrappers all default to `source: 'main'`; the compaction-target rewrapper defaults to `'compaction'`.

Logging is best-effort: if `onRequest` throws, the wrapper surfaces the failure to stderr once and continues with the delegated call. Disk-write failures inside `SessionLogger.write` are caught by the existing `surfaceWriteError` path (ADR 0017 invariant).

## Consequences

**Easier.**

- Post-mortems can replay the exact prompt the model saw. "Why did it pick the wrong tool here" stops being a guessing game.
- Cost analysis and prompt-cache audits read directly from JSONL — no model-side telemetry needed.
- Eval pipelines can bucket failures by `source` to see whether the corrector or compaction is producing bad summaries.
- A new ad-hoc call path that goes through `provider.chat` is automatically logged; no per-site instrumentation needed.

**Harder.**

- **Disk usage.** A long session can produce thousands of `model-request` rows, each containing the full accumulated conversation. File size grows roughly quadratically with turn count. ADR 0017 already accepts monotonic growth; this multiplies the constant. `factory sessions prune` becomes more important; users on small disks may want to opt out via `--no-log`.
- **Privacy.** The JSONL at `~/.factory/sessions/*.jsonl` now mirrors every byte sent to the LLM — file contents read via the `Read` tool, pasted snippets, command outputs, env-derived strings. ADR 0017 already accepted that user-input and tool-results hit disk; this extends the surface to anything assembled into the prompt. Defaults are unchanged (mode = user umask), but the file is materially more sensitive than before. Users sharing session logs for debugging should review the content.
- **Per-call source** plumbing. The `_requestSource` field on `ChatOptions` is a logging concern leaking into a provider-facing type. We accept this cost over the alternatives (rewrapping the provider per use site, or threading a separate options bag): it's one optional field providers strip naturally, and it keeps the wrapping graph simple — one decorator per provider instance.

**Known gap.**

- Subagent (Delegate tool) calls are *not* currently wrapped. `registerSubagentTool` runs at process startup in `src/index.ts`, before any per-tab `SessionLogger` exists; the same comment block already notes "needs per-tab tool registration to fix properly" (`src/index.ts:151-156`). Once that follow-up lands, the Delegate tool will receive a wrapped provider and `source: 'subagent'` rows will start appearing. The `'subagent'` literal in `ModelRequestSource` is included now so the schema is forward-compatible.

**Invariants future contributors must preserve.**

- Every `Provider` instance held by a session-scoped reference (refs.provider, compaction targets, rotation `withKey`/`withTuple` outputs, future picker-spawned variants) must be wrapped via `instrumentProviderRequests` when a `SessionLogger` is present. The `src/ui/session-bridge.ts:logModelRequestTo` helper is the single conversion point — don't reimplement.
- New call sites that bypass the active session provider (a fresh `createProvider` somewhere) must wrap before use, or risk dropping rows on the floor. The rotation-wrap regression that motivated this ADR is the canonical example.
- New subsystems that call `chat` / `chatNoStream` on the active provider should set `_requestSource` if they have a distinct identity (e.g. a new "tool-arg-repair" subsystem would want its own source); otherwise inherit `'main'`.
- The schema (`source`, `streaming`, `messages`, `tools`, `options`) is part of the contract per ADR 0017. Renaming or restructuring is a breaking change for log readers.
