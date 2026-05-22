# 0023 — All errors and warnings must reach the session log

- **Status:** Accepted
- **Date:** 2026-05-22
- **Supersedes:** —
- **Superseded-by:** —

## Context

ADR 0017 made the JSONL session log the authoritative observability surface: post-mortems, eval harnesses, and future analytics all read it. That contract only holds if the log actually captures what went wrong.

A real incident exposed the gap: a user-visible `Cannot switch to <name>: Unknown provider: …` notice from a failed `/model` switch was rendered in the TUI but never appeared in the session file. The error was thrown inside `createProvider` (`src/providers/registry.ts`), caught in `swap.ts`, and routed through `addNotice('danger', …)` — and `addNotice` only updated React state. The same gap existed in the provider picker (which uses `setStage({ kind: 'error' })` directly), in MCP startup failures (which called `console.error`), and in several silent compaction-resolver fallbacks. Each of these is an error the operator and the user will eventually want to investigate. None of them reached the JSONL.

The pattern was structural, not per-callsite: components that owned UI error rendering had no visibility of the session logger, so each catch made an independent (and usually wrong) choice about whether to log.

## Decision

Every error or warning that is surfaced to the user — by `addNotice('danger' | 'warn', …)`, by an error stage in the provider picker, or by any equivalent affordance in headless mode — **must** also be written to the active session log via `SessionLogger.logWarning(source, message)`. The logger is the single source of truth for what the agent saw and tried to communicate.

To make this enforceable rather than aspirational, the routing lives at the surface where errors are *displayed*, not at each call site:

- `addNotice` in `use-agent-loop.ts` mirrors `danger` and `warn` notices into `sessionLogger.logWarning` (likewise `addNoticeBlock`). Any new caller that uses `addNotice('danger', …)` is logged automatically.
- UI components that don't go through `addNotice` (e.g. `ProviderPicker`, which manages its own error stage) accept an `onError(source, message)` callback; the host wires it back to the agent's `addNotice`/`logWarning`.
- Headless mode catches that previously swallowed errors (e.g. compaction-resolver fallback) call `sessionLogger?.logWarning(...)` before returning the fallback value.

`source` is a short tag identifying the origin (`notice:danger`, `picker:loadModels:<provider>`, `compaction-resolver`, `hook-error`, …) so the log is greppable.

## Consequences

**Easier.**

- A user reporting "X failed" can paste their session file and the failure is already there — no need to re-run with a debug flag.
- Eval harness and post-mortem tooling can count error rates and categorize by `source` without needing terminal capture.
- New error paths inherit logging automatically as long as they reach the user through the standard notice surface.

**Harder.**

- Components that own their own error rendering (the picker today, future overlays tomorrow) cannot just call `setStage({ kind: 'error' })` — they must also call the host-provided `onError` callback. The contract is documented next to the prop.
- Pre-session failures (MCP startup, argv parsing, `--compaction-model` parsing in `src/index.ts`) cannot satisfy this ADR because the per-tab `SessionLogger` does not yet exist when they fire. They remain on stderr; if a future change moves logger creation earlier in startup, replay them through the logger then. This is the only sanctioned exemption.
- The `SessionLogger.logWarning` schema is now load-bearing for more event categories. Renaming `source` values or restructuring the row shape is a breaking change for log readers (see ADR 0017).

**Invariants future contributors must preserve.**

- No new `addNotice('danger' | 'warn', …)` path may bypass the logger. If you find one, the fix is at the `addNotice` surface, not the call site.
- New UI components that render errors out-of-band from `addNotice` must accept an `onError` callback wired by the host.
- Silent catches (`} catch { … }`) in code paths that have access to a `SessionLogger` are not acceptable; either log a warning or let the error propagate. Pure-fallback catches still log the reason for the fallback.
- `console.error` is reserved for failures that occur before any session exists. After session start, prefer `sessionLogger.logWarning`.
