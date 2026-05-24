# core/session — orientation

Session-log writer + readers. Every agent event, model request, user input, slash command, and lifecycle transition is appended to a JSONL file under `~/.factory/sessions/<ts>-<id>.jsonl`. The same module also reads recent logs back for the recent-sessions picker and the REPL input-history pre-population.

## Public entry

- `createSessionLogger(opts?)` (`session-log.ts`) — opens a fresh JSONL file for the current process and returns a `SessionLogger`. Writes are batched (one `setImmediate`-scheduled flush per event-loop turn) so hot tool-call loops don't pay a syscall per line.
- `SessionLogger` interface — 14 typed `log*` methods. **Add a new event type by adding a new method here, not by passing arbitrary strings to a generic `log()`** — every write path goes through a named method so consumers know what shapes exist.
- `getLastSessionSelection()` — used by the startup picker to pre-select the most-recent provider/model.
- `getRecentSessions(limit)` — recent-sessions picker. Deduplicates by `provider/model`; sessions with no `user-input` lines are dropped (skip abandoned probes).
- `loadHistoryFromSessions(limit)` — extracts `user-input` content for REPL up-arrow history. Collapses consecutive duplicates.
- `sessionsDir()` — exposes `factoryHomePath('sessions')` for diagnostics.

## Files

- `session-log.ts` — writer + readers + format definitions (468 LOC; intentionally one file because writer and readers must agree on the shape of every line).
- `key-stats.ts` — per-key usage rollup derived from session logs.

## Log-format contract — additive only

Session logs are the **persisted on-disk format** of agent activity. They outlive the process. Readers in `session-log.ts` (and downstream tooling that postprocesses `~/.factory/sessions/`) tolerate unknown fields and unknown event types, but they **assume the existing fields keep their existing meanings**.

The contract is:

1. **Adding a new event type is safe.** `serializeEvent` and the rollup readers ignore unknown `type` values. Future readers will pick the new type up; old readers will skip it.
2. **Adding a new optional field on an existing event type is safe** as long as `undefined` means "old behaviour".
3. **Renaming a field on `session-start`, `model-change`, `user-input`, or `agent-event` is a breaking change.** `parseSessionStart` and `rollupSessionLines` read these explicitly; they don't tolerate renames. The `STARTUP_MODEL_PLACEHOLDER` sentinel (`'<startup>'`) is also load-bearing — `rollupSessionLines` filters it from the "final model" computation. Don't repurpose the string.
4. **Changing the shape of a field is a breaking change.** Anywhere the readers do `typeof x === 'string'` or `Array.isArray(x)`, the field is part of the contract.
5. **`logModelChange` must pass `providerAfter` when the backend provider changes** (not just the model). Without it, the recent-sessions rollup labels the session under the original provider while the UI shows the new one. The interface comment calls this out — preserve it.

If you genuinely need a breaking change, write a migration that rewrites historical logs and version the directory (`~/.factory/sessions-v2/`). Don't silently change the shape of an existing event.

## The `serializeEvent` filter

`logAgentEvent` runs `event` through `serializeEvent` before writing. The filter currently:

- Strips `respond` from `permission-request` events (it's a function — `JSON.stringify` would emit `undefined` and the runtime callback would leak into the log otherwise).
- Reshapes `error` events to `{ type, error: { message, stack } }` so the full `Error` doesn't serialize to `{}`.

**If you add an `AgentEvent` variant that carries a function or a non-serializable value, extend `serializeEvent` to strip it.** There's no compile-time check; the symptom is silently truncated log lines (or a thrown TypeError under strict logging).

## Write semantics

- **Init throws.** `createSessionLogger` opens the fd synchronously so a permissions / ENOSPC failure surfaces at startup. After init, no `write` ever throws — logging is observability, not a hard dependency.
- **First failure surfaces to stderr; subsequent failures are silent.** A full disk would otherwise flood stderr with one line per write.
- **`onWriteError` is the strict-mode escalation hook.** `cli/headless.ts` wires it to `process.exit` under `--strict-log` so CI runs fail loudly on a corrupt log instead of producing a half-written one.
- **`close()` flushes synchronously.** Callers that `process.exit` immediately after close (headless mode) need the tail of the queue on disk before they go.

## Reader assumptions

The three readers (`getLastSessionSelection`, `getRecentSessions`, `loadHistoryFromSessions`) each:

1. Skip files that don't start with a valid `session-start` line.
2. Tolerate JSON parse errors line-by-line — a partial / truncated log still yields what it can.
3. Cap fan-out (`limit * 4` for recent, `FANOUT_CAP = 32` for history) to bound fs reads when `~/.factory/sessions/` is huge.

If you add a new reader, follow the same pattern: stream + tolerate + cap. Don't `JSON.parse` the whole file as an array.

## Adding a log method

1. Extend the `SessionLogger` interface in `session-log.ts`.
2. Implement the method in `createSessionLogger`'s returned object.
3. If the new method emits a new event `type`, document its shape inline in the interface JSDoc (every existing method has one; that's the spec).
4. If a downstream reader cares about the new type, extend the rollup logic. Otherwise readers will harmlessly skip it.

## Don't

- **Don't pass arbitrary objects through a generic `log(type, ...)` API.** _Folklore:_ no mechanical check. Every event type has a typed method so the format stays discoverable. A consumer reading the JSONL has only the writer's surface to go on.
- **Don't rename fields on the existing event types.** _Folklore:_ no mechanical check. The readers above match field names literally. A rename breaks `getRecentSessions` silently — old sessions still have the old names, new sessions have the new ones, and the rollup picks neither up.
- **Don't add an `AgentEvent` variant with a non-serializable field** without extending `serializeEvent`. _Folklore:_ no mechanical check. Symptom is silently truncated log lines.
- **Don't throw from `write` / a `log*` method.** _Folklore:_ no mechanical check. The first-failure-to-stderr + `onWriteError` pattern is the strict-mode contract; throwing breaks every caller's expectation that logging is fire-and-forget.
- **Don't repurpose `'<startup>'`** as anything other than the model placeholder. _Folklore:_ no mechanical check. `rollupSessionLines` filters it explicitly.
