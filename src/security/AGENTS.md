# security — orientation

The primitive that gates every I/O-shaped tool call. Path jail, bash deny list, env scrubbing, and the per-tool / per-domain permission state machine. **Built-in rules cannot be overridden — only extended.**

## Public entry

- `PermissionManager` (`permissions.ts`) — allow-once / allow-always / per-domain (WebFetch) state. The agent loop calls `evaluateTool(name)` or `evaluateBashCommand(cmd)` before dispatching; the UI surfaces a prompt on `{ kind: 'prompt' }`.
- `evaluateBash(command, rules)` + `checkForbidden(command)` (`bash-rules.ts`) — built-in deny list (`rm -rf /`, fork bomb, `curl | sh`, `dd to /dev/*`) plus user globs. Built-ins win over allow rules; user rules are first-match.
- `isPathAllowed(path, policy)` / `assertPathAllowed(...)` (`paths.ts`) — symlink-aware jail. Built-in deny list covers `~/.ssh`, `~/.aws`, `~/.gnupg`, `/etc/shadow`, etc.; the `PathPolicy` argument carries user-supplied additions.
- `sanitizeEnv(env, policy)` (`env.ts`) — deny-by-default env scrubber with a small `safe-vars` whitelist. Used by Bash and by the hooks runner.

## Files

- `permissions.ts` — `PermissionManager` class + `PermissionDecision` enum.
- `paths.ts` — path jail (`PathPolicy`, `isPathAllowed`, `assertPathAllowed`, `normalizePath`). All file tools route through this before touching disk.
- `bash-rules.ts` — `BashRule` type, `evaluateBash`, built-in `FORBIDDEN_PATTERNS`. The built-ins are an exported list intentionally — extending the built-in deny list is one PR; weakening it requires touching the list directly (visible).
- `env.ts` — `EnvPolicy` + `sanitizeEnv`. Default-deny with a small whitelist; user `allow` extends.

## Invariants enforced in `test/unit/arch/modularity.test.ts`

`security/**` is a **primitive**: it must not depend on any sibling top-level folder (`providers/`, `tools/`, `core/`, `ui/`, `mcp/`, `cli/`). Two consequences worth knowing:

1. `permissions.ts` references tool names through `TOOL_NAMES` imported from `utils/tool-names.ts` (not from `tools/`). This is why `TOOL_NAMES` physically lives in `utils/` even though `tools/types.ts` re-exports it for tool authors — `security/` can't import from `tools/`.
2. Path / env / bash policy types (`PathPolicy`, `EnvPolicy`, `BashRule`) are imported FROM here by other layers. Don't move them out — every layer should accept policies as opaque values defined here.

## Adding a security rule

| Change                  | Touch                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| New built-in path deny  | extend the constant in `paths.ts`                                                                                                           |
| New built-in bash deny  | extend the `FORBIDDEN_PATTERNS` list in `bash-rules.ts`                                                                                     |
| New env var to scrub    | extend the deny list in `env.ts` (or — better — leave it denied by default and only extend the safe-vars whitelist with a strong rationale) |
| New permission category | extend `PermissionDecision` in `permissions.ts`; update every caller of `evaluateTool` / `evaluateBashCommand`                              |

## Don't

- **Don't add a way for user config to override built-ins.** _Folklore:_ no mechanical check. Extending is allowed; weakening is not. The hard-deny posture is load-bearing — `bash-rules.ts` and `paths.ts` are the last gate before disk / shell. Candidate for a property test on the next change here.
- **Don't import from `tools/`, `core/`, `providers/`, `ui/`, `mcp/`, or `cli/`** here. _Enforced by arch test:_ `security/**` is a primitive — it must not depend on any sibling top-level folder. If a security check needs information from a sibling layer, the caller passes it in as a policy / context value.
- **Don't bypass `PathPolicy` / `EnvPolicy` plumbing** by calling `process.cwd()` / `process.env` inside a security function. _Enforced by arch test:_ `test/unit/arch/modularity.test.ts` — "src/security/\*\* must read policy snapshots, not process.cwd() / process.env directly". Security primitives are shaped as pure functions of `(input, policy)`; reading process state directly substitutes the parent process's state for the policy the caller passed in. The case that matters most today is `env.ts` — `process.env` contains every secret in the user's shell, and `EnvPolicy` is the only thing gating which env vars a subprocess can inherit.

Note on the safe-vars env whitelist: each additional entry in `env.ts`'s allow list expands what subprocesses can read. The list is intentionally short. Adding to it should come with a JSDoc rationale on the entry; reviewers (human or automated) should flag PRs that grow the list silently.
