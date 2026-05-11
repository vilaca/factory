# Troubleshooting

When something looks wrong, the first place to look is the session log: `/log` shows the path. Logs live under `~/.factory/sessions/` as JSONL — one line per event. Search with `jq` or `grep`.

For verbose startup output, set `FACTORY_DEBUG=1` (or pass `--debug`) — picker, auth, provider creation, model discovery, and validation each print a checkpoint line to stderr.

## Common issues

### "Connection refused" or `ECONNREFUSED`

- Ensure your local server is running: `ollama serve` for Ollama; `llama-server` for llama.cpp.
- Check the host/port: `factory --host http://localhost:11434`.
- For remote servers, confirm the firewall lets you in.

### "Model not found"

- List available models: `ollama list` for Ollama, the provider's web UI for cloud providers.
- For Ollama: `ollama pull <model>` first.
- Or run `factory` with no `--model` to open the picker.

### "Invalid API key" / authentication errors

- Verify the env var: `echo $ANTHROPIC_API_KEY` (or whichever provider).
- Check for typos.
- Re-enter via the picker: `factory -p anthropic --pick`.
- Saved keys live in `~/.config/factory/config.json` under `keys.<provider>[]`. You can edit by hand if needed.

### Tool calls not working / model outputs text instead

- The startup banner reports `tool support: native | basic | none` for the chosen model.
- For `none`, the text-tool parser (`src/core/agent/tool-calls/text-tool-parser.ts`) recovers calls from prose. Quality varies by model.
- The LLM tool-call corrector tries to fix malformed calls; toggle with `/correct on|off`.

### Edit tool fails with "old_string not found"

- The Edit tool requires an exact textual match. Read the file first to see exact whitespace.
- The fuzzy fallback handles minor whitespace mismatches, but exact matches always win.
- For multi-line edits, copy from the Read output verbatim.

### Session hangs or becomes unresponsive

- Press `Esc` to abort the current turn.
- `Ctrl+C` once aborts; `Ctrl+C` twice in quick succession force-exits.
- Use `--turn-timeout 120` to auto-abort turns after N seconds.
- `/log` to grab the session-log path, then check the last few events for a stuck tool call or provider call.
- OpenAI / OpenAI-compatible streams have a 30 s idle watchdog: if the server stops emitting events mid-stream the call fails with a 504 "OpenAI SSE stream stalled (idle timeout)" instead of hanging. Tune via `FACTORY_OPENAI_SSE_IDLE_TIMEOUT_MS` (longer for heavy o1/o3/o4/gpt-5 reasoning, shorter for aggressive failover).

### Permission prompts are noisy

- Press `a` (allow-all) for trusted tools — applies for the rest of the session.
- Start in plan mode with `--plan` so the agent queues edits for batch approval.
- `/permissions` resets the in-session allow list.

### High token usage / context window exceeded

- `/clear` resets conversation history.
- The agent auto-compacts older messages when approaching the model's context window.
- The `readCache` experimental flag (`/exp readCache on`) deduplicates repeat file reads.
- `/stats` shows cache hit rate and the largest tool results — high tool-result sizes are usually the culprit.

### "Can't find `factory` after `npm link`"

- Confirm npm global bin is on `PATH`: `echo $PATH | tr ':' '\n' | grep $(npm config get prefix)`.
- Use `npx factory` as a fallback.
- Or invoke directly: `node /path/to/factory/dist/index.js`.

### Windows: bash tool errors

The Bash tool spawns `sh` and assumes a Unix shell. Run factory under WSL (Windows Subsystem for Linux) or Git Bash. Native `cmd.exe` and PowerShell are not supported.

### Long output truncated in the terminal

- The Read tool shows a 5-line preview by default; the full content goes to the model.
- `/full` toggles the preview to show full output for the rest of the session.

## When to file an issue

If the above doesn't help, [open an issue](https://github.com/vilaca/factory/issues) with:

- `factory --version`
- OS and Node version
- The exact `factory ...` command
- The session log excerpt (redact any tokens before pasting)
