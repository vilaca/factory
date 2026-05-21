# Manual RC checklist

Run this list against the **release candidate build** (not the branch). It
covers what the automated harness in `test/e2e/` cannot — real network calls,
real OAuth, terminal feel, cross-platform sanity. Everything else is gated by
`npm run test:e2e`; if that's green and this list is green, ship.

Time budget: ~15 minutes on a single machine.

## 1. Real provider smoke

These exercise actual cloud auth and streaming — the e2e mocks can't.

- [ ] `factory -p anthropic -m claude-sonnet-4-6` with a real key prints a reply to a one-line prompt. Streaming feels smooth, no flicker.
- [ ] `factory -p openai -m gpt-5` does the same.
- [ ] `factory -p ollama -m <local-model>` against a real local Ollama works (if Ollama is installed on the test machine).
- [ ] `/stats` after the run shows non-zero `cache_read_input_tokens` on Anthropic by turn 2.

## 2. OAuth device flows

- [ ] `factory -p copilot` with no saved token opens the GitHub device-code flow, browser handoff, returns to a working CLI on Enter-after-paste.
- [ ] `factory -p googleaistudio` with `--auth-mode adc` (or default) flows through Google ADC.
- [ ] Saved Copilot token is reused on the next launch (no re-prompt).

## 3. Terminal feel

- [ ] Status bar legible on the tester's actual terminal — branch + provider/model + token counter all visible at standard width (80–120 cols).
- [ ] Markdown rendering: a reply containing **bold**, `code`, lists, and a fenced block looks right.
- [ ] Light-background terminal: status bar and accent colors still readable. (Skip if you only run dark.)
- [ ] Esc aborts a long turn within roughly half a second and the prompt comes back clean (no partial output stuck on screen).
- [ ] Ctrl+C while idle exits cleanly; Ctrl+C twice while running aborts then exits.

## 4. Picker UX

- [ ] Provider picker arrow keys feel responsive (no input lag at 8 rows).
- [ ] Alphabetical-jump shortcuts (typing 'A' for Anthropic, 'B' for Ollama, etc.) work.
- [ ] Picker focus indicator is visible and follows the highlighted row.
- [ ] After picking a key with a label, the label is reflected in the status bar.

## 5. Real WebFetch

- [ ] WebFetch against a real public URL (e.g. a documentation page) returns parseable Markdown.
- [ ] First fetch of a new domain prompts for allow/deny; second skips the prompt.

## 6. Cross-platform sanity (only if you have the boxes)

- [ ] macOS Terminal.app + iTerm2: full run-through (one of each).
- [ ] Linux: any standard terminal.
- [ ] Windows Terminal: at least `factory --version` + a one-prompt headless run. (Full TUI on Windows is best-effort until CI matrix exists.)

## 7. Install integrity

- [ ] `npx factory-code --version` against the tagged tarball prints the expected version.
- [ ] `factory --help` matches the version (no stale help text).

---

## What the harness covers (so this list stays short)

For reference — these don't need to be re-tested manually:

- All CLI flag parsing (`test/e2e/cli-flags.test.ts`)
- Headless exit codes 0/2/3/6 + `--no-log` / `--strict-log` (`test/e2e/headless.test.ts`)
- Each built-in tool wired end-to-end (`test/e2e/tools.test.ts`)
- Bash deny list (`test/e2e/bash-tool.test.ts`)
- Path jail (`test/e2e/security.test.ts`)
- env < global < project < CLI config precedence (`test/e2e/config-precedence.test.ts`)
- Lifecycle hooks fire (`test/e2e/hooks.test.ts`)
- Skills loader (`test/e2e/skills.test.ts`)
- MCP stdio server registration + tool call (`test/e2e/mcp.test.ts`)
- WebFetch allowlist + redirect + 404 (`test/e2e/webfetch.test.ts`)
- Slash commands `/help` `/clear` `/exp` + unknown (`test/e2e/slash-commands.test.ts`)
- Multi-tab Ctrl+T + `/tabs` + `/switch` (`test/e2e/tabs.test.ts`)
- Picker Ctrl+K re-open (`test/e2e/picker.test.ts`)
- Plan mode queue + `/approve` (`test/e2e/plan-mode.test.ts`)
- Provider auth (Ollama, Copilot, HuggingFace token prompt) (`test/e2e-mocks.test.ts`)

If something in this manual list keeps breaking release after release,
promote it into the harness — keep this list as small as it can be.
