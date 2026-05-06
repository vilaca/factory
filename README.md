# 🏭 factory

![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

**A coding agent that runs anywhere — local or cloud, frontier or 7B — with the resilience to make smaller models actually useful.**

- **Bring your own model.** 15 providers on equal footing — local-first ([Ollama](https://ollama.ai), [llama.cpp](https://github.com/ggerganov/llama.cpp)) and cloud ([Anthropic Claude](https://www.anthropic.com), [Cerebras](https://cloud.cerebras.ai/), [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/), [Codestral](https://codestral.mistral.ai), [Cohere](https://cohere.com/), [GitHub Copilot](https://github.com/features/copilot), [Google AI Studio](https://aistudio.google.com), [Groq](https://console.groq.com/), [HuggingFace](https://huggingface.co), [Mistral](https://mistral.ai), [OpenCode Zen](https://opencode.ai/docs/zen/), [OpenRouter](https://openrouter.ai), [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)). Pick what fits your privacy, cost, and latency.
- **Multi-tab sessions.** Each tab is an independent agent with its own conversation, working directory, provider, and model. Run a frontier LLM on a refactor in one tab while a local LLM explores tests in another. Switch with `Ctrl+N`/`Ctrl+P` or jump directly with `F1`–`F12`.
- **Two-tier rotation.** When a key hits a rate limit or auth failure, factory swaps to the next saved key for the same model; when keys for a model are exhausted, it walks a configurable chain of `<provider>:<model>` fallbacks — frontier → fast → free, automatic. Configure with `/rotate`; per-key usage and rate-limit state surfaced via `/keys` and picker badges.
- **Built for models that don't behave.** Text-tool fallback recovers tool calls from prose for models without native function calling. An LLM-based corrector retries malformed calls with a fixed signature. An imitation guard strips fabricated tool-result blocks. Bash dedup nudges the model out of spinning loops.
- **Plan mode.** Read-only tools execute freely; writes are queued for review. Approve, cancel, or refine before anything touches disk.
- **Cache-aware by default.** Surfaces prompt-cache hit rate per turn and per key for providers that report it. `/stats` reports session totals, per-turn hit-rate sparkline, compaction events, and the largest tool results. See [Cost & Token Management](#cost--token-management).
- **Human or headless.** Interactive TUI on a TTY; in scripts and CI it auto-detects no-TTY, reads stdin as a prompt, runs one turn, and streams the result to stdout — same agent, no UI.

## Requirements

- **Node.js >= 22**
- At least one LLM provider — local ([Ollama](https://ollama.ai), [llama.cpp](https://github.com/ggerganov/llama.cpp)) or cloud (see [Environment variables](#environment-variables) for the credential each provider expects)

## Quick Start

```bash
git clone https://github.com/vilaca/factory.git

cd factory
npm install && npm run build && npm link

factory
```

That's it. `factory` opens a picker for provider, model, and API key the first time. Subsequent runs jump straight into the prompt with the last provider/model you used; pass `--pick` (or use `/pick` / `Ctrl+K` mid-session) to choose a different one.

> **`npm link` permission errors?** It writes a symlink into your npm global prefix; if that's a system path it needs sudo. Either set a user-writable prefix once (`npm config set prefix "$HOME/.npm-global"` and add `$HOME/.npm-global/bin` to your `PATH`), or skip linking and run `npx factory` from the repo, or invoke directly with `node /path/to/factory/dist/index.js`.

## Table of Contents

- [Features](#features)
- [Slash Commands](#slash-commands)
- [Hotkeys](#hotkeys)
- [Experimental Flags](#experimental-flags)
- [Configuration](#configuration)
  - [Command-line flags](#command-line-flags)
  - [Environment variables](#environment-variables)
  - [Config files](#config-files)
  - [Project instructions](#project-instructions)
- [Advanced Features](#advanced-features)
  - [Multi-Tab Sessions](#multi-tab-sessions)
  - [Provider/Model Picker](#providermodel-picker)
  - [Plan Mode](#plan-mode)
  - [Permission System](#permission-system)
  - [Auto-Correction](#auto-correction)
  - [Cost & Token Management](#cost--token-management)
  - [Session Logs](#session-logs)
  - [Headless / Non-TTY Mode](#headless--non-tty-mode)
- [Architecture](#architecture)
- [Development](#development)
  - [Testing](#testing)
  - [Contributing](#contributing)
  - [Adding a Provider](#adding-a-provider)
  - [CI/CD](#cicd)
- [Troubleshooting](#troubleshooting)
- [Security Considerations](#security-considerations)
- [License](#license)

## Features

- **Interactive REPL** with streaming markdown rendering
- **Multi-tab sessions**: each tab carries its own conversation, working directory, provider, and model — switch with `Ctrl+N`/`Ctrl+P`, jump with `F1`–`F12`, manage with `/new`, `/close`, `/tabs`, `/switch`
- **Built-in tools**: Read, Write, Edit, Bash, Glob, Grep
- **Permission system**: approve, deny, or allow-all per tool type
- **Multi-provider support**: Anthropic Claude, Cerebras, Cloudflare Workers AI, Codestral, Cohere, GitHub Copilot, Google AI Studio, Groq, HuggingFace, llama.cpp, Mistral, Ollama, OpenCode Zen, OpenRouter, Vercel AI Gateway
- **Per-tab provider/model switching**: `/pick` (or `Ctrl+K`) for the interactive picker; `/model <provider>:<model>` for a one-shot switch — either path rebinds a single tab without affecting others
- **Provider/model picker**: at startup or mid-session via `/pick` / `Ctrl+K`, with recently-used pairs at the top — same component for both
- **Multiple API keys per provider**: save more than one key for any simple-API-key provider (Anthropic, Groq, Mistral, OpenRouter, Cerebras, Cohere, Vercel, OpenCode Zen, Codestral, Workers AI, HuggingFace), pick which one a tab uses, add new keys inline (validated via `listModels` with a 3 s timeout, with a "save anyway" override for transient failures), delete keys with confirmation. Keys show as `<label> · …<last4>` so the secret never appears in the UI.
- **Two-tier rotation**: tier-1 swaps to the next saved key for the same model on 429/auth failure; tier-2 walks a configurable chain of `<provider>:<model>` fallbacks when all keys for the current model are exhausted. Configure with `/rotate`, override per-launch with `--rotate`/`--no-rotate`/`--no-rotate-keys`/`--no-rotate-models`. Per-key usage and rate-limit counters surface in `/keys` and the picker.
- **Resume on launch**: if a previous session is on file, factory skips the menu and starts on the same provider/model/key (override with `--pick`)
- **Slash commands**: tabs (`/new`, `/close`, `/tabs`, `/switch`), session (`/clear`, `/model`, `/pick`, `/cwd`, `/help`, `/exit`/`/quit`/`/q`, `/permissions`, `/log`), plan mode (`/plan`, `/queue`, `/approve`, `/cancel`), observability (`/keys`, `/stats`), tuning (`/correct`, `/exp`)
- **Cross-session history**: up-arrow recalls inputs from prior sessions, not just the current one
- **Esc to abort**: stops the running agent immediately
- **Tool support detection**: queries provider APIs at startup; reports native vs. fallback support
- **Text-tool fallback**: auto-recovers tool calls from text content (`<tool_call>` blocks, JSON fences, or bare JSON)
- **Imitation guard**: detects and strips fabricated tool-result blocks from model output
- **Auto-retry**: when a tool call fails, the agent injects corrective feedback and retries (budget of 3 attempts)
- **Auto-correction**: LLM-based tool-call corrector retries failed calls with a fixed signature (budget of 5 per run, disable with `--no-auto-correct`)
- **Bash deduplication**: detects three near-duplicate Bash commands and nudges the model to stop spinning (enable with `--bash-dedup`)
- **Read cache**: stamps Read with mtime + SHA-256 so repeat reads short-circuit (on by default; `--no-read-cache` to disable)
- **Plan mode**: queue write operations for review before execution (`/plan` or `--plan`)
- **Project facts**: auto-detects the project's stack and injects key metadata into the system prompt — Node (`package.json` name/version/engines/scripts), TypeScript (`tsconfig.json` target/module/strict/outDir), Rust (`Cargo.toml` name/version/edition), Go (`go.mod` module + version), plus presence-only markers for Python, JVM (Java/Kotlin/Scala), Ruby, PHP, Elixir, and C/C++
- **Fuzzy Edit fallback**: whitespace-normalized matching when exact string match fails
- **Session logging**: every interaction logged to `~/.factory/sessions/*.jsonl`

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands and hotkeys |
| `/new [<label>]` | Open a new tab |
| `/close` | Close the active tab |
| `/tabs` | List open tabs |
| `/switch <n\|label>` | Switch to a tab by index, label, or unique prefix |
| `/clear` | Clear conversation history |
| `/model [<name>]` | Show current provider/model, or switch (accepts `<provider>:<model>` to switch both) |
| `/pick` | Open the provider/model picker (recent pairs first) |
| `/rotate` | View the active rotation chain. Subcommands: `add`, `insert`, `remove`, `move`, `clear`, `refresh` (return to the head of the chain and reset the in-memory failure log) |
| `/keys [<provider>]` | Show saved keys with usage / rate-limit / cache-hit counters |
| `/stats` | Cache hit rate, compaction events, and largest tool results for the current session |
| `/full` | Show full Read output in the terminal instead of the 5-line preview (applies going forward; the model always sees the full text either way) |
| `/cwd [<dir>]` | Show or change the active tab's working directory |
| `/permissions` | Reset tool permissions |
| `/plan` | Toggle plan mode or show queued plan |
| `/queue` | Show the queued plan |
| `/approve` (or `y`) | Execute the queued plan |
| `/cancel` (or `n`) | Drop the queued plan |
| `/log` | Show current session log path |
| `/correct on\|off` | Toggle LLM tool-call corrector |
| `/exp [<name> on\|off]` | List or toggle experimental flags |
| `/exit`, `/quit`, `/q` | Exit (or close the active tab if multiple are open) |

## Hotkeys

| Key | Action |
|-----|--------|
| `Ctrl+K` | Open the provider/model picker |
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close active tab (or exit if last) |
| `Ctrl+N` / `Ctrl+P` | Cycle to next / previous tab |
| `F1`–`F12` | Jump directly to tab N |
| `Ctrl+C` | Abort running turn (or exit when idle) |
| `Esc` | Abort the current agent run |
| `↑` / `↓` | Recall previous / next prompt |

## Experimental Flags

| Flag | Default | Description |
|------|---------|-------------|
| `bashDedup` | off | Tracks recent Bash commands. When the model runs three near-duplicate commands (token-level Jaccard ≥ 0.5), injects a system nudge to prevent spinning. |
| `readCache` | on | Stamps Read operations with mtime + sha256. Repeat reads short-circuit with a reference to prior result, saving tokens. |
| `lineCountHint` | on | Adds system-prompt hint: prefer `cloc`/`scc` when available; avoid running multiple line-counting variants. |

Toggle via CLI (`--bash-dedup`, `--no-read-cache`, `--no-line-count-hint`), via the config file under `agent.experimental`, or at runtime with `/exp <name> on|off`.

## Configuration

Three layers, lowest to highest precedence: config files → environment variables → CLI flags. The picker writes saved credentials and last-used provider/model to the user-level config file; you usually don't need to edit it by hand.

### Command-line flags

| Flag | Short | Description |
|------|-------|-------------|
| `--provider <name>` | `-p` | Provider name or alias (e.g. `anthropic`, `claude`, `gemini`, `or`) |
| `--model <name>` | `-m` | Model to use; accepts `<provider>:<model>` |
| `--host <url>` | | Override the provider's default host (e.g. remote Ollama, llama.cpp) |
| `--token <token>` | `-t` | API token (overrides env var and saved credential) |
| `--plan` | | Start in plan mode |
| `--no-auto-correct` | | Disable LLM tool-call corrector |
| `--bash-dedup` | | Enable Bash near-duplicate detector |
| `--no-read-cache` | | Disable Read mtime/hash cache |
| `--no-line-count-hint` | | Drop the cloc/scc system-prompt hint |
| `--turn-timeout <sec>` | | Auto-abort agent after N seconds |
| `--no-log` | | Disable session JSONL logging |
| `--no-clear` | | Do not clear the screen on startup |
| `--pick` | | Force the startup picker even when a previous session is on file |
| `--rotate <a:b,c:d>` | | Default rotation chain (comma-separated `<provider>:<model>`); session-only unless `--save-rotate` |
| `--save-rotate` | | Persist `--rotate` to global config |
| `--no-rotate` | | Disable both key rotation and model rotation |
| `--no-rotate-keys` | | Disable key rotation (still rotate provider/model entries) |
| `--no-rotate-models` | | Disable model rotation (still rotate keys within the same model) |
| `--help` | `-h` | Show help |

### Environment variables

Provider credentials. Set whichever ones you use; the picker also saves them to the config file the first time you enter them. Saved keys live in `keys[<provider>]` in the config file (each entry has an `id`, `token`, `createdAt`, optional `label`, and optional `extras` for things like Workers AI's `accountId`); the legacy flat `*Token` fields are migrated to a single default-labelled entry on first launch and kept in place for downgrade safety.

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic Claude |
| `CEREBRAS_API_KEY` | Cerebras |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Workers AI |
| `CODESTRAL_API_KEY` | Codestral |
| `COHERE_API_KEY` | Cohere |
| `GITHUB_COPILOT_API_KEY` (or `COPILOT_API_KEY`) | GitHub Copilot |
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | Google AI Studio |
| `GOOGLE_APPLICATION_CREDENTIALS` | Google AI Studio service-account JSON (alternative to API key) |
| `GROQ_API_KEY` | Groq |
| `HF_TOKEN` (or `HUGGING_FACE_HUB_TOKEN`) | HuggingFace |
| `MISTRAL_API_KEY` | Mistral |
| `OPENCODE_ZEN_API_KEY` (or `OPENCODE_API_KEY`) | OpenCode Zen |
| `OPENROUTER_API_KEY` | OpenRouter |
| `AI_GATEWAY_API_KEY` (or `VERCEL_OIDC_TOKEN`) | Vercel AI Gateway |

Behavioural overrides:

| Variable | Purpose |
|----------|---------|
| `FACTORY_DEBUG=1` | Print startup checkpoints (picker, auth, provider, models, validation) to stderr |
| `XDG_CONFIG_HOME` | Override config directory (defaults to `~/.config`) |
| `FACTORY_GITHUB_LOGIN_BASE_URL` | Override GitHub OAuth host for Copilot auth |
| `FACTORY_GITHUB_API_BASE_URL` | Override GitHub API host for Copilot auth |

For Google AI Studio OAuth via ADC instead of an API key:

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/generative-language.retriever
```

### Config files

Configuration is read from:
1. Project-level: `./.factory/config.json`
2. User-level: `~/.config/factory/config.json` (or `$XDG_CONFIG_HOME/factory/config.json`)

Project values override user-level; CLI flags and env vars override both.

Example `config.json`:

```json
{
  "provider": "<llm-provider>",
  "model": "<llm-model>",
  "agent": {
    "experimental": {
      "bashDedup": false,
      "readCache": true,
      "lineCountHint": true
    }
  }
}
```

### Project instructions

Create `.factory/INSTRUCTIONS.md` in your repository root for project-specific guidelines that get appended verbatim to the system prompt:

```markdown
## Example Project Conventions

- Use TypeScript strict mode
- Prefer async/await over callbacks
- Run tests before committing: npm test
- Never modify files in dist/ directory
```

## Advanced Features

### Multi-Tab Sessions

Each tab is an independent agent: its own conversation, working directory, provider, and model. Open one tab against a frontier cloud LLM for a refactor, another against a local LLM for cheap exploration, and a third in a different repo entirely — they don't share state.

**Managing tabs:**

| Action | Command | Hotkey |
|--------|---------|--------|
| New tab | `/new [label]` | `Ctrl+T` |
| Close active tab | `/close` | `Ctrl+W` |
| List tabs | `/tabs` | — |
| Switch by index/label/prefix | `/switch <n\|label>` | `F1`–`F12` (by index) |
| Cycle | — | `Ctrl+N` / `Ctrl+P` |

**Per-tab provider and model:**

```
> /pick                                   # interactive picker (or Ctrl+K)
> /model <llm-provider>:<llm-model>       # one-shot switch (rebinds this tab only)
> /model <llm-model>                      # swap model, keep provider
> /cwd ~/work/other-repo                  # change working directory
```

Other tabs keep their own provider/model/cwd. Aborting a turn (`Esc` / `Ctrl+C`) only affects the active tab.

### Provider/Model Picker

`/pick` (or `Ctrl+K`) opens an interactive panel above the prompt. Same component that appears at startup, just rendered inline. The flow:

1. **Recent** — `<provider> / <model>` pairs from `~/.factory/sessions/*.jsonl`, sorted newest-first and deduped. Status badges (`(throttled)`, `(out of quota)`, `(permission denied)`, `(error)`) flag pairs whose last session ended on a model-side error. A trailing `Pick a different provider` entry jumps to the provider list (also bound to `p`).
2. **Provider** — descriptor labels, dimmed `(offline)` for ones that didn't probe, jump shortcuts `0–9` / `A–Z`. Picking a single-credential provider (Copilot device-flow, Google AI Studio OAuth, Ollama, llama.cpp) hands off to the existing auth path. Picking a simple-API-key provider continues to:
3. **Key** — list of saved keys for that provider as `<label> · …<last4>`, with trailing `Add new key…` and `Delete a key…` entries.
   - **Add** prompts for the token in a masked input. Hitting `Enter` validates by calling `listModels` against the new token (3 s timeout). On success the key is persisted and the picker advances to the model list. On failure, you choose between `edit` (re-edit the typed token without retyping the whole thing) or `save anyway` (persist anyway — useful for transient quota/network failures).
   - **Delete** is a two-step pick → confirm.
4. **Model** — the chosen provider/key's model list, with display names and warnings via the provider's `getModelPickerInfo`. Number/letter shortcuts also work here.

`Esc` always backs up one stage; `Esc` from the recent list cancels and closes the picker (mid-session) or exits factory (startup).

A switch made via the picker is recorded in the session log alongside the keyId, so the next launch resumes on exactly the same provider/key/model. Pass `--pick` to force the menu when you want to choose differently.

### Plan Mode

Toggle with `/plan` or start with `--plan`. In plan mode:

- **Read-only tools** (Read, Glob, Grep) execute immediately — the model investigates freely
- **Write tools** (Edit, Write, Bash) are queued for review — the REPL prints `[planned #N] ToolName`
- After the model finishes, you review the plan:
  - Type `y` or `/approve` to execute all queued operations in order
  - Type `n` or `/cancel` to drop the plan
  - Type anything else to refine — the queue clears and the model rebuilds based on your feedback

The status line shows `[PLAN]` when active. Useful for exploratory prompts like "review the project and suggest improvements" where you want to see what the model proposes before it touches your files.

**Example workflow:**

```
> refactor the authentication module
🔍 Read(file_path="src/auth.ts")
Allow this Read? (y/n/a): a

📖 [Read result shown...]

[planned #1] Edit(file_path="src/auth.ts", old_string="...", new_string="...")
[planned #2] Write(file_path="src/auth.test.ts", content="...")
[planned #3] Bash(command="npm test")

--- 3 operations queued ---
Execute plan? (y=approve, n=cancel, or type to refine): y

✓ Edit: src/auth.ts
✓ Write: src/auth.test.ts
✓ Bash: npm test
  [output shown...]

Plan executed successfully.
```

### Permission System

Every tool call requires explicit permission:

```
🔧 Read(file_path="src/index.ts")
Allow this Read? (y/n/a): 
```

Responses:
- **y** / **yes** — Allow this specific call
- **n** / **no** — Deny this call (model receives error message)
- **a** / **allow all** — Auto-approve all future calls of this tool type for the session

Reset permissions with `/permissions` to return to prompt-per-call mode.

### Auto-Correction

When a tool call fails (e.g., `old_string` not found in Edit), the corrector LLM:
1. Analyzes the failure context
2. Reads relevant file content if needed
3. Produces a fixed tool call
4. Retries automatically

Capped at 5 corrections per run. Never repeats a failed call signature.

**Disable:**
```bash
factory --no-auto-correct
# or at runtime:
> /correct off
```

### Cost & Token Management

Long sessions get expensive because the agent re-sends the full conversation prefix every turn — system prompt, tool definitions, and every prior message. Most providers offer some form of prompt caching that turns those repeated prefix tokens into cheap cache reads. factory tracks the split per turn and per key so you can see whether caching is actually working.

**Per-key stats.** `/keys` shows cumulative cached vs. uncached input tokens, hit rate, and a 🔥 marker on keys whose last cache read landed within the last 5 minutes (Anthropic's default cache TTL). The picker uses the same data to flag warm keys.

**`/stats`.** Reports for the current session:

- Total input tokens split into cached / fresh and the resulting hit rate
- Cumulative cache-creation tokens (relevant for explicit caching providers)
- A per-turn hit-rate sparkline so you can spot which turn killed the cache
- Compaction events with the turns they fired on
- The five largest tool results by approximate token count

Auto-cache providers (OpenAI / Cerebras / Groq / Mistral / OpenRouter / Vercel / OpenCode Zen / Copilot / Cohere / llama.cpp) return cache splits in their `prompt_tokens_details.cached_tokens` field, so hit rate lights up immediately without any client-side configuration.

**Anthropic explicit caching.** factory emits up to three `cache_control: { type: 'ephemeral' }` markers per call — at the end of the tools array, the end of the system prompt, and the end of the most recent completed assistant turn. Default 5-minute TTL. Any non-Anthropic provider ignores the boundary hint, so the same code path works everywhere; Anthropic's own `cache_read_input_tokens` and `cache_creation_input_tokens` flow back into the per-key stats and `/stats` so the savings are visible.

For cross-session analysis, the JSONL session log under `~/.factory/sessions/` contains every `usage` field. See [`docs/observability.md`](docs/observability.md) for `jq` recipes (session totals, hit-rate trends, tool-result distribution, outlier turns).

### Session Logs

Each REPL session writes a JSONL transcript to `~/.factory/sessions/<timestamp>-<id>.jsonl`.

Log events include:
- `session-start`: timestamp, provider, model
- `user-input`: raw input
- `slash-command`: command and args
- `agent-*`: text chunks, tool calls, tool results, recoveries, errors
- `session-end`: timestamp

**View current log path:**
```
> /log
Session log: /Users/you/.factory/sessions/2026-05-05T12-34-56-abc123.jsonl
```

**Tail log in another terminal:**
```bash
tail -f ~/.factory/sessions/2026-05-05T12-34-56-abc123.jsonl
```

⚠️ **Privacy Note:** Session logs may contain sensitive data including API responses, file contents, and command outputs. Review logs before sharing or storing in version control.

Disable with `--no-log`.

### Headless / Non-TTY Mode

When stdin or stdout isn't a TTY (piped input, CI jobs, scripts), `factory` skips the interactive TUI and runs in headless mode: it reads stdin to EOF as a single user prompt, executes one agent turn, streams the assistant's text to stdout, and writes tool diagnostics to stderr.

```bash
echo "what does src/index.ts do?" | factory -p <llm-provider> -m <llm-model>
```

**Permissions in headless mode.** There's no TTY to answer permission prompts, so any tool that isn't pre-allowed will be denied and the process exits with code 3. To grant access, list the tools in your config:

```json
{
  "permissions": {
    "allowAll": ["Read", "Glob", "Grep"]
  }
}
```

Be deliberate about which tools you allow — `Bash`, `Edit`, and `Write` execute side effects without confirmation in this mode.

**Exit codes.** `0` success, `1` agent error, `2` empty stdin, `3` permission denied (no TTY), `4` turn limit, `5` token limit.

Session logs are written exactly as in interactive mode, so headless runs are still inspectable in `~/.factory/sessions/`.

## Architecture

```
src/
├── index.ts                       # Entry point, CLI args, model selection
├── permissions.ts                 # Tool permission management
├── types.d.ts                     # Top-level type declarations
├── core/
│   ├── agent.ts                   # Agent loop (streaming + tool dispatch)
│   ├── agent-types.ts             # Agent event/option types
│   ├── config.ts                  # Config load/save
│   ├── config-types.ts            # Config schema types
│   ├── conversation.ts            # Message history
│   ├── context-manager.ts         # Token tracking + compaction
│   ├── credentials.ts             # Saved-key resolution + migration
│   ├── key-stats.ts               # Per-key usage / rate-limit counters
│   ├── provider-errors.ts         # Classify 429/auth/etc. for rotation
│   ├── system-prompt.ts           # Dynamic system prompt generation
│   ├── project-facts.ts           # Auto-extracted project metadata
│   ├── model-validation.ts        # Tool-support validation
│   ├── text-tool-parser.ts        # Recover tool calls from text (fallback)
│   ├── tool-result-format.ts      # Tool-result sentinel + imitation stripping
│   ├── tool-call-corrector.ts     # LLM-based tool call correction
│   ├── session-log.ts             # Per-session JSONL logging
│   └── agent/                     # Agent submodules
│       ├── call-model.ts          # Provider call + streaming
│       ├── parse-response.ts      # Model response parsing
│       ├── run-tool-calls.ts      # Tool execution + permission checks
│       ├── compaction.ts          # Context window compaction
│       ├── recovery-state.ts      # Auto-retry and correction state
│       ├── repeat-detector.ts     # Consecutive failure detection
│       ├── bash-dedup.ts          # Bash near-duplicate detector
│       └── file-cache.ts          # Read mtime/hash cache
├── ui/
│   ├── ink/
│   │   ├── App.tsx                # Top-level TUI app (tabs + global keys)
│   │   ├── Session.tsx            # One tab's REPL session
│   │   ├── index.tsx              # Render entry
│   │   ├── types.ts               # Display item types
│   │   ├── slash-commands.ts      # Slash command dispatch
│   │   ├── slash/                 # Per-command handlers (rotate, keys, …)
│   │   ├── format.ts              # Markdown + tool call rendering
│   │   ├── use-agent-loop.ts      # Agent loop hook
│   │   ├── agent-loop/            # Agent loop submodules (init, history, run-loop, ...)
│   │   ├── tabs/                  # Multi-tab registry, context, hook
│   │   └── components/            # TUI components
│   ├── headless.ts                # Headless / non-TTY runner
│   └── renderer.ts                # Markdown rendering
├── cli/
│   ├── args.ts                    # CLI flag parsing
│   ├── auth.ts                    # Provider credential bootstrap
│   ├── parse-rotation.ts          # Parse `--rotate` chain syntax
│   ├── picker.ts                  # Provider/model picker (line-based)
│   ├── prompts.ts                 # Interactive prompts
│   └── startup-menu.tsx           # TUI startup menu
├── providers/
│   ├── types.ts                   # Provider interface
│   ├── registry.ts                # Provider factory
│   ├── descriptors.ts             # Provider metadata (display, env vars, defaults)
│   ├── _openai/                   # Shared OpenAI-compatible adapter (SSE, streaming, tool calls, usage)
│   ├── anthropic.ts               # Anthropic Claude provider
│   ├── cerebras.ts                # Cerebras
│   ├── cohere.ts                  # Cohere
│   ├── copilot.ts                 # GitHub Copilot
│   ├── copilot-auth.ts            # GitHub Copilot auth
│   ├── googleaistudio.ts          # Google AI Studio
│   ├── googleaistudio-auth.ts     # Google AI Studio auth
│   ├── groq.ts                    # Groq
│   ├── huggingface.ts             # HuggingFace Inference API
│   ├── llamacpp.ts                # llama.cpp server
│   ├── mistral.ts                 # Mistral AI + Codestral
│   ├── ollama.ts                  # Ollama provider
│   ├── opencodezen.ts             # OpenCode Zen
│   ├── openrouter.ts              # OpenRouter
│   ├── vercel.ts                  # Vercel AI Gateway
│   └── workersai.ts               # Cloudflare Workers AI
├── tools/
│   ├── read.ts, write.ts, edit.ts, bash.ts, glob.ts, grep.ts
│   ├── types.ts                   # Tool interface
│   ├── registry.ts                # Tool registry
│   └── index.ts                   # Barrel export
├── mcp/                           # MCP server integration
│   ├── types.ts                   # MCP types
│   ├── client.ts                  # MCP client
│   └── adapter.ts                 # MCP provider adapter
└── utils/
    ├── git.ts                     # Git operations
    ├── tokens.ts                  # Token estimation
    └── build-info.ts              # Build metadata
```

## Development

### Testing

```bash
npm test          # Full suite (unit + e2e)
npm run test:unit # Unit tests only
npm run test:e2e  # End-to-end tests only
```

Tests cover:
- CLI flag parsing
- Startup flow and model selection
- All 6 tools
- Permission flows
- Slash commands
- Text-tool parser
- Tool-result imitation detection
- Error handling and recovery

### Contributing

We welcome contributions! Here's how to get started:

1. **Fork the repository** on GitHub
2. **Clone your fork:**
   ```bash
   git clone https://github.com/your-username/factory.git
   cd factory
   ```
3. **Create a feature branch:**
   ```bash
   git checkout -b feature/your-feature-name
   ```
4. **Make your changes** and ensure:
   - Code follows the existing style
   - Tests pass: `npm test`
   - Linting passes: `npm run lint`
   - TypeScript compiles: `npm run build`
5. **Commit with clear messages:**
   ```bash
   git commit -m "feat: add support for new provider"
   ```
6. **Push and create a Pull Request:**
   ```bash
   git push origin feature/your-feature-name
   ```

**Found a bug?** [Open an issue](https://github.com/vilaca/factory/issues) with:
- Steps to reproduce
- Expected vs actual behavior
- Environment (OS, Node version, provider)
- Session log excerpt if relevant

### Adding a Provider

1. Implement the `Provider` interface from `src/providers/types.ts`:
   ```typescript
   interface Provider {
     name: string;
     listModels(): Promise<ModelInfo[]>;
     chat(options: ChatOptions): Promise<ChatResponse>;
     // ... see types.ts for full interface
   }
   ```
   For OpenAI-compatible APIs (most cloud inference services), reuse the shared adapter in `src/providers/_openai/` — it handles SSE, streaming, tool calls, and usage parsing. See `cerebras.ts` or `groq.ts` for thin examples.
2. Add an entry to `src/providers/descriptors.ts` (label, aliases, env vars, default host).
3. Wire up the factory in `src/providers/registry.ts`.
4. Add tests under `test/unit/`.
5. Update the env-var table in [Configuration → Environment variables](#environment-variables).

### CI/CD

GitHub Actions workflows handle releases and security scanning. See [`.github/workflows/README.md`](.github/workflows/README.md) for details.

## Troubleshooting

### Common Issues

**"Connection refused" or "ECONNREFUSED"**
- Ensure Ollama is running: `ollama serve`
- Check the host/port: `factory --host http://localhost:11434`
- For llama.cpp: ensure `llama-server` is running on the expected port

**"Model not found"**
- List available models: `ollama list`
- Pull the model: `ollama pull qwen2.5-coder`
- Or use the interactive model picker: just run `factory`

**"Invalid API key" or authentication errors**
- Verify environment variable is set: `echo $ANTHROPIC_API_KEY`
- Check for typos in the API key
- Try re-entering with: `factory -p anthropic` (it will prompt again)

**Tool calls not working / model outputs text instead**
- Check tool support at startup — you'll see "native" or "fallback"
- Some models don't support function calling natively
- The text-tool fallback will attempt recovery automatically

**Edit tool fails with "old_string not found"**
- Read the file first to see exact content
- Copy/paste the exact string including whitespace
- The fuzzy fallback helps, but exact matches work best

**Session hangs or becomes unresponsive**
- Press `Esc` to abort the current agent run
- Use `--turn-timeout 120` to auto-abort after N seconds
- Check session log with `/log` for details

**Permission prompts are annoying**
- Use `a` (allow all) for trusted tool types
- Or start in plan mode: `factory --plan`
- Reset with `/permissions` if you change your mind

**High token usage / context window exceeded**
- Use `/clear` to reset conversation history
- The agent auto-compacts older messages when approaching limits
- Check `readCache` experimental flag to reduce duplicate file reads

**Can't find npm global command after `npm link`**
- Ensure npm global bin is in PATH: `npm config get prefix`
- Try `npx factory` instead
- Or run directly: `node /path/to/factory/dist/index.js`

Still stuck? Check the [session logs](#session-logs) or [open an issue](https://github.com/vilaca/factory/issues).

## Security Considerations

⚠️ **Important Security Notes:**

1. **Bash Tool Execution**: The Bash tool executes arbitrary shell commands with your user permissions. Review commands carefully before approving, especially with models you don't trust.

2. **API Key Storage**: Credentials are stored in plaintext in `~/.config/factory/config.json` (or `$XDG_CONFIG_HOME/factory/config.json`). The file is created with mode `0o600` and the directory with mode `0o700`; factory also repairs looser permissions on the next save. Credentials are not encrypted at rest, so anyone with access to your user account can read them.

3. **File System Access**: The Read, Write, Edit, Glob, and Grep tools can access any file your user can. Use plan mode (`--plan`) for untrusted models.

4. **Network Requests**: Some providers make API calls to external services. Review privacy policies before using cloud-based providers.

5. **Project Instructions**: The `.factory/INSTRUCTIONS.md` file is injected into every prompt. Avoid storing sensitive information there.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

---

**Links:**
- [GitHub Repository](https://github.com/vilaca/factory)
- [Issue Tracker](https://github.com/vilaca/factory/issues)
- [Workflow Documentation](.github/workflows/README.md)
