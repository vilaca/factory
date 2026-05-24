# core/hooks — orientation

User-configured shell hooks fired at specific lifecycle events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `SessionEnd`, `Stop`, `StopFailure`). Each hook is an external command launched with a sandboxed env and bounded timeout; its stdout is parsed as JSON for structured control (`cancel`, `errorMessage`, `additionalContext`, `notice`).

## Public entry

- `runHooks(event, opts)` (`index.ts`) — fires all hooks matching `event` (and optional `matchValue`). Returns a `HookResult` with `cancel`, `errorMessage`, `additionalContext`, `notice`, `firedCommands`, `errors`. Never throws; per-hook execution errors land in `errors`.
- `resolveHooks(event, config, matchValue?)` (`discovery.ts`) — pure resolver that filters configured hooks for one event.
- `listAllHooks(config)` (`discovery.ts`) — every configured hook across every event. Used at startup and by the `/hooks` slash command to surface what will fire this session.
- `HOOK_EVENTS` + `HookEvent` (`discovery.ts`) — the event enum.
- `trustPromptForNewHooks` (`trust.ts`) — first-run trust prompts for new hook scripts.

## Files

- `index.ts` — the executor. Spawns child processes with `sanitizeEnv`, enforces `checkForbidden` against the hook command itself, parses JSON stdout, bounds timeout.
- `discovery.ts` — `HOOK_EVENTS`, `HookEvent`, `resolveHooks`, `listAllHooks`. Pure config queries.
- `trust.ts` — interactive trust state for unfamiliar hook scripts.

## Per-event semantics

`additionalContext` in the result has different meanings per event:

| Event              | `additionalContext` behaviour                                                          |
| ------------------ | -------------------------------------------------------------------------------------- |
| `PreCompact`       | Replaces the compaction summary text                                                   |
| `SessionStart`     | Appended to the conversation as a user message before the next model call              |
| `UserPromptSubmit` | Appended to the conversation right after the user's prompt, before the model is called |
| anything else      | Ignored (no defined injection point)                                                   |

`cancel: true` from a `PreToolUse` hook denies the tool call. From other events it's informational only.

## Where hooks fire

- `SessionStart`, `SessionEnd` — `cli/startup/phase-runtime-lifecycle.ts` (or wherever session boundaries live).
- `UserPromptSubmit` — `core/agent/hooks-runner.ts` (called from `run-agent.ts`).
- `PreToolUse`, `PostToolUse`, `PostToolUseFailure` — `core/agent/tool-calls/run-tool-calls.ts`.
- `PreCompact` — `core/agent/compaction.ts`.
- `Stop`, `StopFailure` — `core/agent/hooks-runner.ts` (called on turn-complete).

When you wire a new firing site, the call goes through one of: `runHooks` directly, or one of the `fire*` helpers in `core/agent/hooks-runner.ts`. Prefer the latter when the new event is agent-loop-shaped (so the AgentEvent translation is consistent with peers).

## Performance / caching

`getSanitizedEnv(policy)` caches the scrubbed env keyed on the policy _identity_ (object reference, not value). Callers should snapshot the policy once at session start and reuse the same object — re-running `sanitizeEnv` on every fire matters because hook chains can fire dozens of times per turn (`PreToolUse` + `PostToolUse` on every Bash call, plus `Pre/PostTurn`).

## Security

- Hook commands themselves are run through `checkForbidden` from `security/bash-rules.ts`. A hook that matches a built-in deny pattern fails before spawn.
- Env is scrubbed via `sanitizeEnv` with the session's `EnvPolicy` — same deny-list as Bash.
- `trust.ts` gates _new_ hook scripts on first run (prompts the user). Trusted hashes are stored per script; modifications re-prompt.
- `cli/startup/phase-trust-and-subagent.ts:handleProjectTrust` strips project-declared hooks before they reach this layer if the user rejects the trust prompt. By the time `runHooks` is called, the hook list has already been filtered to trusted entries.

## Adding a new hook event

1. Add to `HOOK_EVENTS` in `discovery.ts` (and the `HookEvent` union — automatic via `typeof`).
2. Add config validation in `core/config/validate.ts` if the event needs new shape.
3. Wire the firing site. Prefer adding a `fire<Name>` helper in `core/agent/hooks-runner.ts` for agent-loop events.
4. Document the `additionalContext` semantics above if the event takes input from hook output.

## Don't

- **Don't add a hook event without documenting `additionalContext` semantics** in this file and in `HookResult`'s JSDoc. The default is "ignored", but unclear semantics breed config bugs.
- **Don't bypass `checkForbidden` for hook commands.** The built-in deny list applies to hooks too — they spawn with the user's shell.
- **Don't make `runHooks` throw.** Every per-hook failure goes into the `errors` array; the agent loop must not crash on a misconfigured hook.
- **Don't pass `process.env` directly to a hook subprocess.** Always go through `getSanitizedEnv(policy)`.
- **Don't add a synchronous "wait for user confirmation" inside a hook fire.** Trust prompts go through `trust.ts`, which integrates with the UI's permission flow.
