# Headless / non-TTY mode

When stdin or stdout isn't a TTY (piped input, CI jobs, scripts), `factory` skips the interactive TUI and runs in headless mode: it reads stdin to EOF as a single user prompt, executes one agent turn, streams the assistant's text to stdout, and writes tool diagnostics to stderr.

```bash
echo "what does src/index.ts do?" | factory -p anthropic -m claude-sonnet-4-6
```

The detection is automatic — explicit overrides are not needed.

## Permissions in headless mode

There's no TTY to answer permission prompts, so any tool that isn't pre-allowed will be **denied** and the process exits with code 3. To grant access, list the tools in your config:

```json
{
  "permissions": {
    "allowAll": ["Read", "Glob", "Grep"]
  }
}
```

Be deliberate about which tools you allow — `Bash`, `Edit`, and `Write` execute side effects without confirmation in this mode. The same goes for any MCP tools you've registered: their names go in the same `allowAll` array.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0`  | Success |
| `1`  | Agent error (provider failure, unhandled rejection, etc.) |
| `2`  | Empty stdin (nothing for the agent to act on) |
| `3`  | Permission denied (no TTY to prompt) |
| `4`  | Turn limit hit (`--turn-timeout`) |
| `5`  | Token limit / context-window exhausted |
| `130` | SIGINT |

## Session logs

Session logs are written exactly as in interactive mode, so headless runs are still inspectable in `~/.factory/sessions/`. Combined with `--strict-log`, you get a CI-friendly contract: if logging fails, the run fails non-zero.

## Patterns

**One-shot question against the codebase:**

```bash
echo "summarize what src/core/agent/run-agent.ts does" | factory \
  -p anthropic -m claude-sonnet-4-6 --no-clear
```

**Read-only research with all read tools allowlisted:**

```json
{
  "permissions": {
    "allowAll": ["Read", "Glob", "Grep", "WebFetch"]
  }
}
```

**Hardened CI run that captures the session log and fails on log errors:**

```bash
factory --strict-log < prompt.txt 2> stderr.log
echo "exit=$?"
ls -la ~/.factory/sessions/  # latest session log captures every event
```

**Combine with `--turn-timeout` to bound run time in CI:**

```bash
factory --turn-timeout 120 < prompt.txt
```
