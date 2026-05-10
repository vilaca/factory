# Configuration

Three layers, lowest to highest precedence: **config files → environment variables → CLI flags**. The picker writes saved credentials and last-used provider/model to the user-level config file; you usually don't need to edit it by hand.

## Command-line flags

| Flag                   | Short | Description                                                                                        |
| ---------------------- | ----- | -------------------------------------------------------------------------------------------------- |
| `--provider <name>`    | `-p`  | Provider name or alias (e.g. `anthropic`, `claude`, `gemini`, `or`)                                |
| `--model <name>`       | `-m`  | Model to use; accepts `<provider>:<model>`                                                         |
| `--host <url>`         |       | Override the provider's default host (e.g. remote Ollama, llama.cpp)                               |
| `--token <token>`      | `-t`  | API token (overrides env var and saved credential)                                                 |
| `--plan`               |       | Start in plan mode                                                                                 |
| `--auto-correct`       |       | Enable LLM tool-call corrector (off by default)                                                    |
| `--bash-dedup`         |       | Enable Bash near-duplicate detector                                                                |
| `--no-read-cache`      |       | Disable Read mtime/hash cache                                                                      |
| `--no-line-count-hint` |       | Drop the cloc/scc system-prompt hint                                                               |
| `--no-subagents`       |       | Disable the `Delegate` tool                                                                        |
| `--no-hooks`           |       | Disable user-supplied lifecycle hook commands                                                      |
| `--turn-timeout <sec>` |       | Auto-abort agent after N seconds                                                                   |
| `--no-log`             |       | Disable session JSONL logging                                                                      |
| `--strict-log`         |       | Exit non-zero if session logging fails (init or first write)                                       |
| `--no-clear`           |       | Do not clear the screen on startup                                                                 |
| `--pick`               |       | Force the startup picker even when a previous session is on file                                   |
| `--rotate <a:b,c:d>`   |       | Default rotation chain (comma-separated `<provider>:<model>`); session-only unless `--save-rotate` |
| `--save-rotate`        |       | Persist `--rotate` to global config                                                                |
| `--no-rotate`          |       | Disable both key rotation and model rotation                                                       |
| `--no-rotate-keys`     |       | Disable key rotation (still rotate provider/model entries)                                         |
| `--no-rotate-models`   |       | Disable model rotation (still rotate keys within the same model)                                   |
| `--debug`              |       | Enable debug logging to stderr (alias for `FACTORY_DEBUG=1`)                                       |
| `--help`               | `-h`  | Show help                                                                                          |
| `--version`            | `-V`  | Print version and exit                                                                             |

## Environment variables

Provider credentials. Set whichever ones you use; the picker also saves them to the config file the first time you enter them. Saved keys live in `keys[<provider>]` in the config file (each entry has an `id`, `token`, `createdAt`, optional `label`, and optional `extras` for things like Workers AI's `accountId`); legacy flat `*Token` fields are migrated to a single default-labelled entry on first launch and kept in place for downgrade safety.

See [providers.md](./providers.md) for the per-provider env-var table.

Behavioural overrides:

| Variable                                | Purpose                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `FACTORY_DEBUG=1`                       | Print startup checkpoints (picker, auth, provider, models, validation) to stderr |
| `XDG_CONFIG_HOME`                       | Override config directory (defaults to `~/.config`)                              |
| `FACTORY_GITHUB_LOGIN_BASE_URL`         | Override GitHub OAuth host for Copilot auth                                      |
| `FACTORY_GITHUB_API_BASE_URL`           | Override GitHub API host for Copilot auth                                        |
| `FACTORY_OPENAI_SSE_IDLE_TIMEOUT_MS` | Max ms between SSE events before an OpenAI stream aborts with a 504. Default `30000`. Raise for heavy reasoning. |
| `FACTORY_OPENAI_RESPONSES_STORE`     | Set to `false`/`0` to send `store: false` on Responses-API calls (disables `previous_response_id` chaining). Default `true`. |

## Config files

Configuration is read from, lowest to highest precedence:

1. **User-level** — `~/.config/factory/config.json` (or `$XDG_CONFIG_HOME/factory/config.json`).
2. **Project-level** — `./.factory/config.json`. Overrides user-level for keys it sets; other keys still come from user-level.

CLI flags and env vars override both.

The user-level config file is created with mode `0o600` on Unix; the parent directory with `0o700`. On Windows, file ACLs are not enforced.

Example `config.json`:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "agent": {
    "experimental": {
      "bashDedup": false,
      "readCache": true,
      "lineCountHint": true,
      "subagents": true,
      "skills": true,
      "hooks": true
    },
    "web": {
      "allowlist": ["docs.anthropic.com"]
    }
  },
  "permissions": {
    "allowAll": ["Read", "Glob", "Grep"],
    "bashRules": [
      { "pattern": "git status*", "decision": "allow" },
      { "pattern": "git push *", "decision": "deny", "note": "Push from a real terminal" }
    ]
  },
  "security": {
    "bashEnv": {
      "allow": ["MY_BUILD_FLAG"],
      "denyPrefixes": ["INTERNAL_"]
    },
    "paths": {
      "deny": ["~/work/private-repo/secrets"]
    }
  },
  "keys": {
    "anthropic": [{ "id": "default", "token": "sk-ant-...", "createdAt": "2025-04-01T00:00:00Z" }]
  }
}
```

The `agent.experimental` block toggles the [experimental flags](#experimental-flags) below. Toggle at runtime with `/exp <name> on|off`.

## Permissions (`permissions`)

Tool-level permissions. The user is prompted before any tool call that isn't pre-allowed; this section pre-allows tools and lays down Bash rules so the prompts don't show up.

| Field       | Type               | Purpose                                                                                                                                                                                                                                                                                       |
| ----------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowAll`  | `string[]`         | Tool names that bypass the per-call prompt. Names match the registered tool ids (`Read`, `Glob`, `Grep`, `Bash`, `Edit`, `Write`, `WebFetch`, plus any MCP tool names). Granting `Bash` here does **not** bypass the built-in forbidden patterns or your own `bashRules` — those still apply. |
| `bashRules` | `BashRuleConfig[]` | Ordered list of glob patterns scoped to Bash. First match wins. Each rule has `pattern` (shell glob), `decision` (`allow` \| `deny` \| `prompt`), and an optional `note` shown in `/permissions`.                                                                                             |

Bash rule evaluation:

1. **Built-in forbidden patterns** (e.g. `rm -rf /`, fork bombs, `curl ... | sh`, force-push to protected branches) — hard deny, no prompt, **cannot be overridden** by `allowAll` or your own rules. The safety net stays on.
2. **Your `bashRules`** — first matching rule wins.
3. `Bash` in `allowAll` — runs without prompt.
4. Otherwise — prompt.

```json
"permissions": {
  "allowAll": ["Read", "Glob", "Grep"],
  "bashRules": [
    { "pattern": "git status*", "decision": "allow" },
    { "pattern": "npm test*",   "decision": "allow" },
    { "pattern": "git push *",  "decision": "deny", "note": "Push from a terminal, not the agent" }
  ]
}
```

For headless mode, see [headless.md](./headless.md) — anything not on `allowAll` is denied (no TTY to prompt) and the run exits with code 3. WebFetch has its own per-domain whitelist on top of this — see [web-fetch.md](./web-fetch.md).

## Security (`security`)

Hardening for the Bash subprocess and the file-access tools (`Read`, `Write`, `Edit`). User entries **extend** the built-in policy — they cannot remove built-in denials.

### `security.bashEnv`

Env-var allowlist for Bash subprocesses. Deny-by-default: only vars whose name is on the allowlist (or matches an allowed prefix) reach the spawned shell, so provider API keys, GitHub tokens, AWS credentials, etc., in your interactive shell don't leak into model-driven commands.

| Field           | Purpose                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| `allow`         | Exact var names to forward in addition to the built-in safe set (`PATH`, `HOME`, `LANG`, `SSH_AUTH_SOCK`, …). |
| `allowPrefixes` | Prefix patterns; e.g. `"MY_"` forwards every `MY_*` var. Built-ins include `LC_`, `GIT_`, `XDG_`.             |
| `deny`          | Exact names to scrub even if otherwise allowed. Wins over allow.                                              |
| `denyPrefixes`  | Prefix variant of `deny`. Wins over allow.                                                                    |

Built-in deny entries (e.g. `GIT_ASKPASS`, `GIT_SSH_COMMAND`) cannot be removed.

### `security.paths`

Path policy for `Read`/`Write`/`Edit`. The built-in deny list covers `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.factory`, `/etc/shadow`, `/etc/sudoers`, etc. Symlinks are resolved with `realpath()` before the check, so a symlink pointing at `~/.ssh/id_rsa` is denied even if its name looks innocuous.

| Field  | Purpose                                                                                                     |
| ------ | ----------------------------------------------------------------------------------------------------------- |
| `deny` | Additional paths to deny. Tilde is expanded. Directory entries cover the directory and everything under it. |

## Project instructions

Create `.factory/INSTRUCTIONS.md` in your repository root for project-specific guidelines that get appended verbatim to the system prompt. factory also picks up agent-guidance files from other tools, in this order, concatenated under per-source `## From <path>` headers:

1. `.factory/INSTRUCTIONS.md` (canonical)
2. `AGENTS.md` (cross-tool convention)
3. `CLAUDE.md` (Claude Code)
4. `.cursorrules` (Cursor)

Total size is capped at ~16 KB; sources past the cap are dropped with a truncation note. Only repo-root files are checked — nested instruction files are ignored.

## Experimental flags

| Flag            | Default | Description                                                                                                                                             |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bashDedup`     | off     | Tracks recent Bash commands. When the model runs three near-duplicate commands (token-level Jaccard ≥ 0.5), injects a system nudge to prevent spinning. |
| `readCache`     | on      | Stamps Read operations with mtime + sha256. Repeat reads short-circuit with a reference to prior result, saving tokens.                                 |
| `lineCountHint` | on      | Adds system-prompt hint: prefer `cloc`/`scc` when available; avoid running multiple line-counting variants.                                             |
| `subagents`     | on      | Registers the `Delegate` tool for spawning a read-only research subagent.                                                                               |
| `skills`        | on      | Loads markdown skill files from `.factory/skills/` and conditionally injects them based on triggers.                                                    |
| `hooks`         | on      | Run user-supplied shell commands at lifecycle events. No-op when no hook commands are configured.                                                       |

Toggle via CLI (`--bash-dedup`, `--no-read-cache`, `--no-line-count-hint`, `--no-subagents`, `--no-skills`, `--no-hooks`), via the config file under `agent.experimental`, or at runtime with `/exp <name> on|off`.
