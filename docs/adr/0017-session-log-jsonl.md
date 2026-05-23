# 0017 — Session log as JSONL in `~/.factory/sessions/`

- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

Observability is needed for three audiences with different access patterns: the user (mid-session `/stats`, post-mortem on a bad turn), the operator (eval harness, cost tracking, retry frequency), and future analytics (mine sessions for patterns, train a router). A single format that serves all three has to be append-only (no log rewriting under contention), structured (machine-readable for the operator), and individually inspectable (no opaque binary blobs the user can't `grep`).

In-process rotation, log shipping, or a database backend would each add operational complexity that solo-developer use doesn't justify and that a team deployment can build on top of trivially.

## Decision

Session logs are JSONL files in `~/.factory/sessions/`, one file per session, append-only. The `SessionLogger` interface in `src/core/session/session-log.ts` exposes typed methods (`logModelChange`, `logToolCall`, `logRotation`, etc.); each call appends one JSON object per line. No in-process rotation, no compaction, no rolling cleanup — files accumulate until the user removes them. The schema is documented in `docs/observability.md` and is treated as a stable contract for tooling that mines the logs.

The first entry written to every session log **must** be a `session-start` record capturing the initial agent state:

```json
{
  "type": "session-start",
  "timestamp": "<ISO-8601>",
  "version": "<software version>",
  "schemaRef": "docs/observability.md",
  "model": "<active model id>",
  "provider": "<provider name>",
  "cwd": "<working directory>",
  "config": { "<key>": "<value>" },
  "tools": ["<tool name>", "..."]
}
```

`version` is the running software version (e.g. from `package.json`). `schemaRef` is always `docs/observability.md`. `config` captures the full resolved configuration at session open time. `tools` lists every tool registered in the `ToolRegistry` at startup, including MCP-backed tools.

Every outgoing LLM call **must** be captured as a `model-request` record immediately before it is dispatched, via `logModelRequest`. This is achieved through a single `instrumentProviderRequests` wrapper (`src/providers/instrument.ts`) applied to the active provider at startup and after every model/provider swap. The wrapper catches all callers — the main agent loop, the tool-call corrector, the compaction summariser, and Delegate-spawned subagents — with no per-call-site logging required:

```json
{
  "type": "model-request",
  "timestamp": "<ISO-8601>",
  "source": "main | compaction | corrector | subagent",
  "streaming": true,
  "provider": "<provider name>",
  "model": "<model id>",
  "messages": ["<verbatim outgoing message list>"],
  "tools": ["<tool definitions sent to the model, if any>"],
  "options": { "<whitelisted ChatOptions fields>" }
}
```

`source` buckets mechanical traffic (`compaction`) separately from user-driven turns (`main`). `messages` are logged verbatim so a post-mortem can replay exactly what the model was given. Compaction-target providers are rewrapped with `source: 'compaction'` so their traffic is distinguishable in cost/eval queries.

Every error or warning surfaced to the user **must** also be written to the session log via `logWarning(source, message)`. See ADR 0023 for the full invariant and the pre-session exemption.

## Consequences

**Easier.**

- `grep`, `jq`, and shell pipelines work on the logs out of the box. No reader library needed.
- Adding a new event type is one method on `SessionLogger` plus a call at the origin site. The JSONL shape absorbs schema growth — readers ignore fields they don't know.
- Each session is independent on disk, so deleting an old run is `rm` of one file.
- `model-request` records make sessions fully replayable: a post-mortem sees exactly what the model was given, across all callers, without any extra instrumentation.
- Errors and warnings are guaranteed to appear in the log (ADR 0023), so a user can share their session file instead of re-running with a debug flag.

**Harder.**

- Disk usage grows monotonically. A long-running user accumulates many files; a separate `factory sessions prune` affordance may be needed eventually but is not part of this decision.
- The schema is a contract. A field rename is a breaking change for anyone analyzing logs; prefer adding a new field and deprecating the old one in a window.
- Highly concurrent writes to the same file are not supported — sessions are single-writer by construction (one process owns the file). If background tasks (M3) start emitting log events from a separate process, they must write to their own file or post events back to the main process.

**Invariants future contributors must preserve.**

- One file per session, append-only. No log rewriting, no in-place updates.
- The first line of every session log is always a `session-start` record; tooling may assume this and use it for version/schema detection.
- Every outgoing LLM call is captured by `instrumentProviderRequests`; do not add per-call-site `logModelRequest` calls and do not bypass the wrapper.
- Every user-visible error or warning is mirrored to the session log; see ADR 0023 for the routing contract and the pre-session exemption.
- New event types extend the schema; existing fields don't get repurposed.
- Telemetry consumers (eval harness, future cost-cap mechanism in 0022) read JSONL with line-level resilience — a partially-written final line doesn't crash the reader.
