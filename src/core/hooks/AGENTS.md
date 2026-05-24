# core/hooks — orientation

User-configured shell hooks fired at specific lifecycle events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `SessionEnd`, `Stop`, `StopFailure`). Each hook is an external command launched with a sandboxed env and bounded timeout; its stdout is parsed as JSON for structured control (`cancel`, `errorMessage`, `additionalContext`, `notice`).

## Public entry

- `runHook<E extends HookEvent>(event, payload, opts)` (`index.ts`) — fires all hooks matching `event` (and optional `matchValue`). Returns `HookResultFor<E>` — the **per-event result surface** described below. The runtime aggregates every field a hook might return; the public type narrows to only those whose semantics are defined for that event. Never throws; per-hook execution errors land in `errors`.
- `resolveHooks(event, config, matchValue?)` (`discovery.ts`) — pure resolver that filters configured hooks for one event.
- `listAllHooks(config)` (`discovery.ts`) — every configured hook across every event. Used at startup and by the `/hooks` slash command to surface what will fire this session.
- `HOOK_EVENTS` + `HookEvent` (`discovery.ts`) — the event enum.
- `HookResultFor<E>` (`index.ts`) — the per-event result type used by `runHook<E>`'s return signature. Resolves to one of three internal tier interfaces (`HookResultBase`, `HookResultWithContext`, `HookResultWithVeto`) via the `HookResultMap` table. See per-event surface table below; flip the tier interfaces from `interface` to `export interface` if a helper needs to operate on a tier directly.
- `trustPromptForNewHooks` (`trust.ts`) — first-run trust prompts for new hook scripts.

## Files

- `index.ts` — the executor. Spawns child processes with `sanitizeEnv`, enforces `checkForbidden` against the hook command itself, parses JSON stdout, bounds timeout.
- `discovery.ts` — `HOOK_EVENTS`, `HookEvent`, `resolveHooks`, `listAllHooks`. Pure config queries.
- `trust.ts` — interactive trust state for unfamiliar hook scripts.

## Per-event result surface

The result of `runHook<E>(event, ...)` is `HookResultFor<E>` — a type that exposes only the fields whose semantics are defined for `event`. The mapping is the single source of truth in `index.ts` (`HookResultMap`) and is enforced bidirectionally against `HOOK_EVENTS` by a compile-time bijection assertion (`_HookResultMapBijection`). Removing or adding a hook event without updating the map breaks the build.

| Event                | Result type             | Surface (in addition to `notice`, `firedCommands`, `errors`) | What the caller does                                                                   |
| -------------------- | ----------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `SessionStart`       | `HookResultWithContext` | `additionalContext?`                                         | Appended to the conversation as a user message before the next model call              |
| `UserPromptSubmit`   | `HookResultWithContext` | `additionalContext?`                                         | Appended to the conversation right after the user's prompt, before the model is called |
| `PreCompact`         | `HookResultWithContext` | `additionalContext?`                                         | Replaces the compaction summary text                                                   |
| `PreToolUse`         | `HookResultWithVeto`    | `cancel`, `errorMessage?`                                    | `cancel: true` denies the tool call; `errorMessage` is the user-facing reason          |
| `PostToolUse`        | `HookResultBase`        | —                                                            | Observability only (notices, errors)                                                   |
| `PostToolUseFailure` | `HookResultBase`        | —                                                            | Observability only                                                                     |
| `SessionEnd`         | `HookResultBase`        | —                                                            | Observability only                                                                     |
| `Stop`               | `HookResultBase`        | —                                                            | Observability only                                                                     |
| `StopFailure`        | `HookResultBase`        | —                                                            | Observability only                                                                     |

This means a `Stop` caller writing `result.cancel` is a **compile error** rather than a silent no-op — the previous footgun ("`cancel` is informational for non-`PreToolUse` events; please don't act on it" in prose) is now structural. Similarly, a `PostToolUse` caller writing `result.additionalContext` is a compile error: there is no defined injection point for post-execution context.

The runtime aggregator inside `runHook` still collects every field a hook might return; the cast to `HookResultFor<E>` at the return statement is what hides the inapplicable ones from the caller. A future PR that wants to add a new injection point (e.g. `PostToolUse` returns `additionalContext` to inform the next turn) only has to flip `PostToolUse` from `HookResultBase` to `HookResultWithContext` in `HookResultMap` — the parser doesn't need to change.

### Adding a new tier

`HookResultBase` / `HookResultWithContext` / `HookResultWithVeto` are the current three tiers. If an event needs both context-injection AND veto semantics, declare a new interface (`HookResultWithContextAndVeto extends HookResultWithContext, HookResultWithVeto`) and use it in `HookResultMap` — do NOT loosen one of the existing tiers to add the missing field, because that would silently grant the new capability to every event already using that tier.

## Where hooks fire

- `SessionStart`, `SessionEnd` — `cli/startup/phase-runtime-lifecycle.ts` (or wherever session boundaries live).
- `UserPromptSubmit` — `core/agent/hooks-runner.ts` (called from `run-agent.ts`).
- `PreToolUse`, `PostToolUse`, `PostToolUseFailure` — `core/agent/tool-calls/run-tool-calls.ts`.
- `PreCompact` — `core/agent/compaction.ts`.
- `Stop`, `StopFailure` — `core/agent/hooks-runner.ts` (called on turn-complete).

When you wire a new firing site, the call goes through one of: `runHooks` directly, or one of the `fire*` helpers in `core/agent/hooks-runner.ts`. Prefer the latter when the new event is agent-loop-shaped (so the AgentEvent translation is consistent with peers).

## Performance / caching

`getSanitizedEnv(policy)` caches the scrubbed env keyed on the policy _identity_ (object reference, not value). Snapshot the policy once at session start and reuse the same object — re-running `sanitizeEnv` on every fire matters because hook chains can fire dozens of times per turn (`PreToolUse` + `PostToolUse` on every Bash call, plus `Pre/PostTurn`). The session bootstrap in `agent-loop/init.ts` is the canonical snapshot site.

## Security

- Hook commands themselves are run through `checkForbidden` from `security/bash-rules.ts`. A hook that matches a built-in deny pattern fails before spawn.
- Env is scrubbed via `sanitizeEnv` with the session's `EnvPolicy` — same deny-list as Bash.
- `trust.ts` gates _new_ hook scripts on first run (prompts the user). Trusted hashes are stored per script; modifications re-prompt.
- `cli/startup/phase-trust-and-subagent.ts:handleProjectTrust` strips project-declared hooks before they reach this layer if the user rejects the trust prompt. By the time `runHooks` is called, the hook list has already been filtered to trusted entries.

## Adding a new hook event

1. Add to `HOOK_EVENTS` in `discovery.ts` (the `HookEvent` union is derived via `typeof`).
2. Add a matching row to `HookResultMap` in `index.ts`, picking the appropriate tier (Base / WithContext / WithVeto). The compile-time bijection check (`_HookResultMapBijection`) will fail until you do — there is no way to ship a new event without choosing its surface.
3. Add config validation in `core/config/validate.ts` if the event needs new shape.
4. Wire the firing site. Prefer adding a `fire<Name>` helper in `core/agent/hooks-runner.ts` for agent-loop events.
5. Update the per-event table above so future agents know what the new event surfaces.

## Don't

- **Don't add a hook event without choosing its result tier.** _Type-enforced:_ the bijection assertion (`_HookResultMapBijection`) at the bottom of `HookResultMap` in `index.ts` fails to compile when `HOOK_EVENTS` and `HookResultMap` go out of sync. The error message names which side is missing the entry. This replaces the previous folklore "remember to update the per-event table when you add an event".
- **Don't loosen an existing result tier to add a single event's capability.** _Folklore:_ no mechanical check today. Declare a new interface (`HookResultWithContextAndVeto` etc.) and use it in `HookResultMap` for the one event that needs the combined surface. Loosening `HookResultBase` to add `additionalContext` for `PostToolUse` would silently grant that capability to `Stop`, `SessionEnd`, etc., undoing the whole point of the per-event split.
- **Don't bypass `checkForbidden` for hook commands.** _Folklore:_ no mechanical check today. The built-in deny list applies to hooks too — they spawn with the user's shell. Candidate for a unit test that exercises `runHook` against a `FORBIDDEN_PATTERNS` sample.
- **Don't make `runHook` throw.** _Folklore:_ no mechanical check today. Every per-hook failure goes into the `errors` array; the agent loop must not crash on a misconfigured hook. A property test fuzzing hook configs and asserting "never throws" would lift this to E.
- **Don't pass `process.env` directly to a hook subprocess.** _Type-enforced:_ the cached env is typed `SanitizedEnv` (the phantom-branded subtype from `security/env.ts`). Additions go through `extendSanitizedEnv` which preserves the brand; `{ ...sanitized, FACTORY_FOO }` would type-erase to plain `ProcessEnv` and silently let a future agent mix in `process.env` keys. The remaining hole — a hostile `spawn(..., { env: process.env })` somewhere else — is an explicit unsafe operation a reader can grep for; the next lift would be a `spawnWithSanitizedEnv` wrapper confining `child_process` imports to one adapter.

Note on trust-and-confirm: trust prompts go through `trust.ts`, which integrates with the UI's permission flow. Adding a synchronous "wait for user confirmation" inside a hook fire blocks the agent loop's event pump; the established pattern is to gate trust _before_ the hook fires (at session start or first-use), not during.
