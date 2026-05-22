# 0017 — Session log as JSONL in `~/.factory/sessions/`

- **Status:** Accepted
- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

Observability is needed for three audiences with different access patterns: the user (mid-session `/stats`, post-mortem on a bad turn), the operator (eval harness, cost tracking, retry frequency), and future analytics (mine sessions for patterns, train a router). A single format that serves all three has to be append-only (no log rewriting under contention), structured (machine-readable for the operator), and individually inspectable (no opaque binary blobs the user can't `grep`).

In-process rotation, log shipping, or a database backend would each add operational complexity that solo-developer use doesn't justify and that a team deployment can build on top of trivially.

## Decision

Session logs are JSONL files in `~/.factory/sessions/`, one file per session, append-only. The `SessionLogger` interface in `src/core/session/session-log.ts` exposes typed methods (`logModelChange`, `logToolCall`, `logRotation`, etc.); each call appends one JSON object per line. No in-process rotation, no compaction, no rolling cleanup — files accumulate until the user removes them. The schema is documented in `docs/observability.md` and is treated as a stable contract for tooling that mines the logs.

## Consequences

**Easier.**

- `grep`, `jq`, and shell pipelines work on the logs out of the box. No reader library needed.
- Adding a new event type is one method on `SessionLogger` plus a call at the origin site. The JSONL shape absorbs schema growth — readers ignore fields they don't know.
- Each session is independent on disk, so deleting an old run is `rm` of one file.

**Harder.**

- Disk usage grows monotonically. A long-running user accumulates many files; a separate `factory sessions prune` affordance may be needed eventually but is not part of this decision.
- The schema is a contract. A field rename is a breaking change for anyone analyzing logs; prefer adding a new field and deprecating the old one in a window.
- Highly concurrent writes to the same file are not supported — sessions are single-writer by construction (one process owns the file). If background tasks (M3) start emitting log events from a separate process, they must write to their own file or post events back to the main process.

**Invariants future contributors must preserve.**

- One file per session, append-only. No log rewriting, no in-place updates.
- New event types extend the schema; existing fields don't get repurposed.
- Telemetry consumers (eval harness, future cost-cap mechanism in 0022) read JSONL with line-level resilience — a partially-written final line doesn't crash the reader.
