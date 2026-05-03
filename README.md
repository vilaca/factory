# factory

An interactive coding agent for the terminal. Tool-using REPL with per-call permission prompts, plan mode, and streaming markdown.

Pick whichever fits your privacy, cost, and latency needs — local models ([llama.cpp](https://github.com/ggerganov/llama.cpp), [Ollama](https://ollama.ai)) or any of 13 cloud providers ([Anthropic Claude](https://www.anthropic.com), [Cerebras](https://cloud.cerebras.ai/), [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/), [Codestral](https://codestral.mistral.ai), [Cohere](https://cohere.com/), [GitHub Copilot](https://github.com/features/copilot), [Google AI Studio](https://aistudio.google.com), [Groq](https://console.groq.com/), [HuggingFace](https://huggingface.co), [Mistral](https://mistral.ai), [OpenCode Zen](https://opencode.ai/docs/zen/), [OpenRouter](https://openrouter.ai), [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)).

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

## Quick Start

```bash
# Install from source
git clone https://github.com/vilaca/factory.git
cd factory
npm install
npm run build
npm link
```

**Start with interactive provider & model picker (recommended!)**
```bash
factory
```

The interactive picker will guide you through:
1. Choosing a provider (Ollama, Anthropic, Copilot, etc.)
2. Setting up API keys if needed (saved for future use)
3. Selecting a model with rich metadata
4. Starting the REPL

**Already know what you want?** Skip the picker:
```bash
factory qwen2.5-coder           # Ollama (must be running)
factory -p anthropic            # Will prompt for API key if needed
```

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
  - [Interactive Provider & Model Selection](#interactive-provider--model-selection-recommended)
  - [Direct Provider/Model Selection](#direct-providermodel-selection)
  - [Providers](#providers)
  - [Options](#options)
  - [Slash Commands](#slash-commands)
- [Tools](#tools)
- [Configuration](#configuration)
  - [Project Instructions](#project-instructions)
  - [Experimental Flags](#experimental-flags)
- [Advanced Features](#advanced-features)
  - [Plan Mode](#plan-mode)
  - [Permission System](#permission-system)
  - [Auto-Correction](#auto-correction)
  - [Session Logs](#session-logs)
  - [Headless / Non-TTY Mode](#headless--non-tty-mode)
- [Architecture](#architecture)
- [Development](#development)
  - [Testing](#testing)
  - [Contributing](#contributing)
  - [CI/CD](#cicd)
- [Troubleshooting](#troubleshooting)
- [Security Considerations](#security-considerations)
- [License](#license)

## Features

- **Interactive REPL** with streaming markdown rendering
- **Built-in tools**: Read, Write, Edit, Bash, Glob, Grep
- **Permission system**: approve, deny, or allow-all per tool type
- **Multi-provider support**: Anthropic Claude, Cerebras, Cloudflare Workers AI, Codestral, Cohere, GitHub Copilot, Google AI Studio, Groq, HuggingFace, llama.cpp, Mistral, Ollama, OpenCode Zen, OpenRouter, Vercel AI Gateway
- **Model picker**: select from installed models interactively
- **Slash commands**: `/clear`, `/model`, `/help`, `/exit` (also `/q`), `/permissions`, `/plan`, `/queue`, `/approve`, `/cancel`, `/log`
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
- **Project facts**: auto-extracts `package.json` and `tsconfig.json` into system prompt
- **Fuzzy Edit fallback**: whitespace-normalized matching when exact string match fails
- **Session logging**: every interaction logged to `~/.factory/sessions/*.jsonl`

## Installation

### Requirements

- **Node.js >= 22**
- One or more LLM providers (see [Providers](#providers) for setup)

### From Source

```bash
git clone https://github.com/vilaca/factory.git
cd factory
npm install
npm run build
npm link
```

Now `factory` is available globally.

## Usage

### Interactive Provider & Model Selection (Recommended)

The easiest way to use factory is with the **interactive picker**. Just run:

```bash
factory
```

You'll see:

1. **Provider Picker** — Choose from available providers (Ollama, Anthropic, Copilot, etc.)
   - Ollama shown only if reachable
   - Other providers shown if API keys are configured or you want to set them up
   - If you used factory before, press Enter to resume your last provider/model

2. **Model Picker** — Browse models with rich metadata:
   - ✅ Tool support, vision, reasoning capabilities
   - 📊 Context window, max output tokens
   - 🆓 Free models (OpenRouter) or preview/experimental warnings
   - Press Enter to resume your previous model

3. **REPL starts** — Begin coding!

**First-time setup:** If you pick a provider without credentials, you'll be prompted to enter your API key. It's saved securely in `~/.factory/config.json` for future sessions.

**Quick exit:** Type `0`, `q`, or `exit` in any picker to quit before starting the REPL.

### Direct Provider/Model Selection

If you already know what you want, skip the pickers:

```bash
# Specify model directly (uses Ollama by default)
factory qwen2.5-coder
factory --model llama3.1

# Use a specific provider
factory -p anthropic -m claude-sonnet-4-6
factory -p copilot -m gpt-4.1

# Start in plan mode (review changes before execution)
factory --plan

# Custom Ollama host
factory --host http://remote-server:11434
```

### Providers

factory supports 15+ LLM providers:

| Provider | Flag | Default Host | Setup |
|----------|------|--------------|-------|
| **Anthropic Claude** | `anthropic`, `claude` | Anthropic API | `export ANTHROPIC_API_KEY=sk-ant-xxx` |
| **Cerebras** | `cerebras` | `https://api.cerebras.ai/v1` | `export CEREBRAS_API_KEY=xxx` |
| **Cloudflare Workers AI** | `workersai`, `workers-ai` | `https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1` | `export CLOUDFLARE_API_TOKEN=xxx`<br>`export CLOUDFLARE_ACCOUNT_ID=xxx` |
| **Codestral** | `codestral` | `https://codestral.mistral.ai/v1` | `export CODESTRAL_API_KEY=xxx` |
| **Cohere** | `cohere` | `https://api.cohere.com` | `export COHERE_API_KEY=xxx` |
| **GitHub Copilot** | `copilot`, `github-copilot` | `https://api.githubcopilot.com` | `export GITHUB_COPILOT_API_KEY=ghu_xxx` |
| **Google AI Studio** | `googleaistudio`, `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai` | See [Google AI Setup](#google-ai-studio-setup) |
| **Groq** | `groq` | `https://api.groq.com/openai/v1` | `export GROQ_API_KEY=xxx` |
| **HuggingFace** | `huggingface`, `hf` | Inference API | `export HF_TOKEN=hf_xxx` |
| **llama.cpp** | `llamacpp`, `llama.cpp` | `http://127.0.0.1:8080` | Run [llama-server](https://github.com/ggerganov/llama.cpp/blob/master/examples/server/README.md) |
| **Mistral** | `mistral`, `mistral.ai` | `https://api.mistral.ai/v1` | `export MISTRAL_API_KEY=xxx` |
| **Ollama** | `ollama` (default) | `http://127.0.0.1:11434` | Install [Ollama](https://ollama.ai) and run `ollama serve` |
| **OpenCode Zen** | `opencodezen`, `zen` | `https://opencode.ai/zen/v1` | `export OPENCODE_ZEN_API_KEY=zen_xxx` |
| **OpenRouter** | `openrouter`, `open-router`, `or` | `https://openrouter.ai/api/v1` | `export OPENROUTER_API_KEY=sk-or-v1-xxx` |
| **Vercel AI Gateway** | `vercel`, `ai-gateway` | `https://ai-gateway.vercel.sh/v1` | `export AI_GATEWAY_API_KEY=agw_xxx` |

#### Setting Up Providers

**Using the Interactive Picker (Recommended):**

Most providers can be set up directly through the picker. When you select a provider without credentials configured, factory will:
1. Prompt you for the API key
2. Save it securely in `~/.factory/config.json`
3. Use it for all future sessions

**Pre-configuring with Environment Variables:**

If you prefer to set up credentials beforehand:

```bash
# Anthropic Claude
export ANTHROPIC_API_KEY=sk-ant-xxx

# GitHub Copilot
export GITHUB_COPILOT_API_KEY=ghu_xxx

# HuggingFace
export HF_TOKEN=hf_your_token

# OpenRouter
export OPENROUTER_API_KEY=sk-or-v1-xxx

# And so on for other providers...
```

Then just run `factory` and pick your provider from the list.

**Direct CLI Usage (Skip Picker):**

```bash
factory -p anthropic -m claude-sonnet-4-6
factory -p copilot -m gpt-4.1
factory -p openrouter -m openai/gpt-4.1
```

#### Google AI Studio Setup

Google AI Studio supports two authentication methods:

**Option 1: API Key**
```bash
export GEMINI_API_KEY=your_api_key
factory -p gemini -m gemini-2.5-pro
```

**Option 2: OAuth via Application Default Credentials (ADC)**
```bash
# Setup ADC
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/generative-language.retriever

# Or use a service account JSON
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/credentials.json

factory -p gemini -m gemini-2.5-pro
```

### Options

| Flag | Short | Description |
|------|-------|-------------|
| `--model <name>` | `-m` | Model to use |
| `--provider <name>` | `-p` | Provider (see table above) |
| `--host <url>` | | Custom server host |
| `--token <token>` | `-t` | API token (also reads from environment) |
| `--no-log` | | Disable session JSONL logging |
| `--plan` | | Start in plan mode |
| `--no-auto-correct` | | Disable LLM tool-call corrector |
| `--bash-dedup` | | Enable Bash near-duplicate detector |
| `--no-read-cache` | | Disable Read mtime/hash cache |
| `--no-line-count-hint` | | Drop cloc/scc system-prompt hint |
| `--turn-timeout <sec>` | | Auto-abort agent after N seconds |
| `--help` | `-h` | Show help |

### Debugging

Set `FACTORY_DEBUG=1` to print startup checkpoints (picker selection, auth flow, provider creation, model listing, validation) to stderr. Useful when the app exits unexpectedly during startup — the last log line tells you which step failed.

```bash
FACTORY_DEBUG=1 factory 2>/tmp/factory-debug.log
# then in another terminal:
tail -f /tmp/factory-debug.log
```

The picker UI keeps writing to stdout, so redirecting only stderr keeps the interactive flow intact.

### Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear conversation history |
| `/model [<name>]` | Switch model or show current |
| `/permissions` | Reset tool permissions |
| `/plan` | Toggle plan mode or show queued plan |
| `/queue` | Show the queued plan |
| `/approve` (or `y`) | Execute the queued plan |
| `/cancel` (or `n`) | Drop the queued plan |
| `/log` | Show current session log path |
| `/correct on\|off` | Toggle LLM tool-call corrector |
| `/exp [<name> on\|off]` | List or toggle experimental flags |
| `/exit`, `/quit`, `/q` | Exit the REPL |
| `Esc` | Abort the current agent run |

## Tools

The assistant has access to 6 tools, matching Claude Code's capabilities:

| Tool | Description | Example |
|------|-------------|---------|
| **Read** | Read file contents with line numbers | `Read(file_path="src/index.ts")` |
| **Write** | Create or overwrite files | `Write(file_path="config.json", content="...")` |
| **Edit** | Exact string replacement in files | `Edit(file_path="app.ts", old_string="...", new_string="...")` |
| **Bash** | Execute shell commands | `Bash(command="npm test")` |
| **Glob** | Find files by pattern | `Glob(pattern="**/*.ts")` |
| **Grep** | Search file contents with regex | `Grep(pattern="TODO", path="src/")` |

## Configuration

### Project Instructions

Create `.factory/INSTRUCTIONS.md` in your repository root to add project-specific guidelines that are automatically included in every model's system prompt:

```markdown
## Project Conventions

- Use TypeScript strict mode
- Prefer async/await over callbacks
- Run tests before committing: npm test
- Never modify files in dist/ directory
```

This file is appended verbatim to the system prompt, making the model aware of your project's standards.

### Config Files

Configuration is read from:
1. Project-level: `./.factory/config.json`
2. User-level: `~/.factory/config.json`

Example `config.json`:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "agent": {
    "experimental": {
      "bashDedup": false,
      "readCache": true,
      "lineCountHint": true
    }
  }
}
```

Saved credentials are stored in the user-level config:
- `anthropicToken`
- `cerebrasToken`
- `codestralToken`
- `cohereToken`
- `copilotToken`
- `geminiToken`
- `groqToken`
- `huggingfaceToken`
- `mistralToken`
- `opencodeZenToken`
- `openrouterToken`
- `vercelToken`
- `workersAiAccountId`
- `workersAiToken`

### Experimental Flags

Three experimental features targeting common failure modes:

| Flag | Default | Description |
|------|---------|-------------|
| `bashDedup` | off | Tracks recent Bash commands. When the model runs three near-duplicate commands (token-level Jaccard ≥ 0.5), injects a system nudge to prevent spinning on command variations. |
| `readCache` | on | Stamps Read operations with mtime + sha256. Repeat reads short-circuit with a reference to prior result, saving tokens. |
| `lineCountHint` | on | Adds system prompt hint: prefer `cloc`/`scc` when available and avoid running multiple line-counting variants. |

**Enable/disable via CLI:**
```bash
factory --bash-dedup --no-read-cache --no-line-count-hint
```

**Enable/disable via config:**
```json
{
  "agent": {
    "experimental": {
      "bashDedup": true,
      "readCache": false,
      "lineCountHint": false
    }
  }
}
```

**Enable/disable at runtime:**
```
> /exp                       # list current state
> /exp bashDedup on          # enable
> /exp readCache off         # disable
> /exp lineCountHint         # toggle
```

## Advanced Features

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
Session log: /Users/you/.factory/sessions/2025-01-10T12-34-56-abc123.jsonl
```

**Tail log in another terminal:**
```bash
tail -f ~/.factory/sessions/2025-01-10T12-34-56-abc123.jsonl
```

⚠️ **Privacy Note:** Session logs may contain sensitive data including API responses, file contents, and command outputs. Review logs before sharing or storing in version control.

Disable with `--no-log`.

### Headless / Non-TTY Mode

When stdin or stdout isn't a TTY (piped input, CI jobs, scripts), `factory` skips the interactive Ink UI and runs in headless mode: it reads stdin to EOF as a single user prompt, executes one agent turn, streams the assistant's text to stdout, and writes tool diagnostics to stderr.

```bash
echo "what does src/index.ts do?" | factory -p ollama -m qwen2.5-coder
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
├── core/
│   ├── agent.ts                   # Agent loop (streaming + tool dispatch)
│   ├── agent-types.ts             # Agent event/option types
│   ├── config.ts                  # Config load/save
│   ├── config-types.ts            # Config schema types
│   ├── conversation.ts            # Message history
│   ├── context-manager.ts         # Token tracking + compaction
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
│   │   ├── App.tsx                # Ink-based interactive UI (TTY mode)
│   │   ├── index.tsx              # Render entry
│   │   ├── types.ts               # Display item types
│   │   ├── slash-commands.ts      # Slash command handling
│   │   ├── format.ts              # Markdown + tool call rendering
│   │   ├── use-agent-loop.ts      # Agent loop hook
│   │   └── components/            # Ink UI components
│   ├── repl.ts                    # Line-based REPL (non-TTY fallback)
│   ├── renderer.ts                # Markdown rendering
│   ├── status-bar.ts              # Bottom status line
│   └── spinner.ts                 # Activity indicator
├── providers/
│   ├── types.ts                   # Provider interface
│   ├── registry.ts                # Provider factory
│   ├── anthropic.ts               # Anthropic Claude provider
│   ├── cerebras.ts                # Cerebras
│   ├── codestral.ts               # Codestral
│   ├── cohere.ts                  # Cohere
│   ├── copilot.ts                 # GitHub Copilot
│   ├── copilot-auth.ts            # GitHub Copilot auth
│   ├── googleaistudio.ts          # Google AI Studio
│   ├── googleaistudio-auth.ts     # Google AI Studio auth
│   ├── groq.ts                    # Groq
│   ├── huggingface.ts             # HuggingFace Inference API
│   ├── llamacpp.ts                # llama.cpp server
│   ├── mistral.ts                 # Mistral AI
│   ├── ollama.ts                  # Ollama provider
│   ├── opencodezen.ts             # OpenCode Zen
│   ├── openrouter.ts              # OpenRouter
│   ├── vercel.ts                  # Vercel AI Gateway
│   └── workersai.ts               # Cloudflare Workers AI
├── tools/
│   ├── read.ts, write.ts, edit.ts, bash.ts, glob.ts, grep.ts
│   ├── types.ts                   # Tool interface
│   └── registry.ts                # Tool registry
├── mcp/                           # MCP server integration
│   ├── types.ts                   # MCP types
│   ├── client.ts                  # MCP client
│   └── adapter.ts                 # MCP provider adapter
└── utils/
    ├── git.ts                     # Git operations
    ├── tokens.ts                  # Token estimation
    └── build-info.ts              # Build metadata
```

### Adding a Provider

Implement the `Provider` interface in `src/providers/types.ts`:

```typescript
interface Provider {
  name: string;
  listModels(): Promise<ModelInfo[]>;
  chat(options: ChatOptions): Promise<ChatResponse>;
  // ... see types.ts for full interface
}
```

Register in `src/providers/registry.ts`.

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

**Adding a new provider:**
- Implement the `Provider` interface in `src/providers/types.ts`
- Add to `src/providers/registry.ts`
- Add tests in `test/unit/`
- Update README provider table

**Found a bug?** [Open an issue](https://github.com/vilaca/factory/issues) with:
- Steps to reproduce
- Expected vs actual behavior
- Environment (OS, Node version, provider)
- Session log excerpt if relevant

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

MIT

---

**Links:**
- [GitHub Repository](https://github.com/vilaca/factory)
- [Issue Tracker](https://github.com/vilaca/factory/issues)
- [Workflow Documentation](.github/workflows/README.md)
