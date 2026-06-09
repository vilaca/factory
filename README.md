# 🏭 factory

[![Lint](https://github.com/vilaca/factory/actions/workflows/lint.yml/badge.svg)](https://github.com/vilaca/factory/actions/workflows/lint.yml)
[![Typecheck](https://github.com/vilaca/factory/actions/workflows/typecheck.yml/badge.svg)](https://github.com/vilaca/factory/actions/workflows/typecheck.yml)
[![Unit tests](https://github.com/vilaca/factory/actions/workflows/test-unit.yml/badge.svg)](https://github.com/vilaca/factory/actions/workflows/test-unit.yml)
[![E2E mocks](https://github.com/vilaca/factory/actions/workflows/test-e2e-mocks.yml/badge.svg)](https://github.com/vilaca/factory/actions/workflows/test-e2e-mocks.yml)
[![E2E no-mocks](https://github.com/vilaca/factory/actions/workflows/test-e2e-no-mocks.yml/badge.svg)](https://github.com/vilaca/factory/actions/workflows/test-e2e-no-mocks.yml)
[![E2E headless](https://github.com/vilaca/factory/actions/workflows/test-e2e-headless.yml/badge.svg)](https://github.com/vilaca/factory/actions/workflows/test-e2e-headless.yml)
[![E2E pty](https://github.com/vilaca/factory/actions/workflows/test-e2e-pty.yml/badge.svg)](https://github.com/vilaca/factory/actions/workflows/test-e2e-pty.yml)
[![Coverage](https://codecov.io/gh/vilaca/factory/branch/main/graph/badge.svg)](https://codecov.io/gh/vilaca/factory)
![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

**A coding agent CLI engineered to make any LLM — local or cloud, frontier or 7B — actually useful.**

## Why factory

- **Bring your own model.** Pick what fits your privacy, cost, and latency. 16 providers on equal footing — local-first ([Ollama](https://ollama.com), [llama.cpp](https://github.com/ggml-org/llama.cpp)) and cloud ([Anthropic Claude](https://www.anthropic.com), [Cerebras](https://cloud.cerebras.ai/), [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/), [Codestral](https://mistral.ai/news/codestral), [Cohere](https://cohere.com/), [GitHub Copilot](https://github.com/features/copilot), [Google AI Studio](https://aistudio.google.com), [Groq](https://console.groq.com/), [HuggingFace](https://huggingface.co), [Mistral](https://mistral.ai), [OpenAI](https://platform.openai.com), [OpenCode Zen](https://opencode.ai/docs/zen/), [OpenRouter](https://openrouter.ai), [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)).
- Supports *Anthropic Claude-Code* [skills](./docs/skills.md) format.
- **Multi-tab sessions.** Each tab is an independent agent with its own conversation, working directory, provider, and model. Run a frontier LLM on a refactor in one tab while a local LLM explores tests in another. Switch with `Ctrl+N`/`Ctrl+P` or jump directly with `F1`–`F12`.
- **Two-tier rotation.** When a key hits a rate limit or auth failure, factory swaps to the next saved key for the same model; when keys for a model are exhausted, it walks a configurable chain of `<provider>:<model>` fallbacks — frontier → fast → free, automatic.
- **Picker with key management.** Startup and in-session pickers support provider → key → model selection, key validation, and saved-key reuse for providers that support multiple API keys.
- **Built for models that don't behave.** Text-tool fallback recovers tool calls from prose; an LLM corrector retries malformed calls; an imitation guard strips fabricated tool-result blocks; Bash dedup nudges the model out of spinning loops.
- **Plan mode.** Read-only tools execute freely; writes are queued for review. Approve, cancel, or refine before anything touches disk.
- **Cache-aware.** Surfaces prompt-cache hit rate per turn and per key for providers that report it. `/stats` reports session totals, per-turn hit-rate sparkline, compaction events, and the largest tool results.
- **Human or headless.** Interactive TUI on a TTY; in scripts and CI it auto-detects no-TTY, reads stdin as a prompt, runs one turn, and streams the result to stdout — same agent, no UI. See [docs/headless.md](./docs/headless.md).

## Requirements

- **Node.js >= 22**
- At least one LLM provider — local ([Ollama](https://ollama.com), [llama.cpp](https://github.com/ggml-org/llama.cpp)) or cloud (see [docs/providers.md](./docs/providers.md) for credentials per provider).

## Quick start

```bash
git clone https://github.com/vilaca/factory.git
cd factory
npm install && npm run build && npm link
factory
```

That's it. `factory` opens a picker for provider, key, and model the first time (for simple-key providers, it can validate and save keys during the flow). Subsequent runs jump straight into the prompt with the last provider/model you used; pass `--pick` (or use `/model` / `Ctrl+K` mid-session) to choose a different one.

> **`npm link` permission errors?** It writes a symlink into your npm global prefix; if that's a system path it needs sudo. Either set a user-writable prefix once (`npm config set prefix "$HOME/.npm-global"` and add `$HOME/.npm-global/bin` to your `PATH`), skip linking and run `npx factory` from the repo, or invoke directly with `node /path/to/factory/dist/index.js`.

> **npm install coming soon.** A `factory-code` package will land on npm once the first tagged release ships; until then, build from source.

## Documentation

- [docs/providers.md](./docs/providers.md) — full provider matrix, env vars, auth specifics
- [docs/configuration.md](./docs/configuration.md) — CLI flags, env vars, config file format, experimental flags
- [docs/slash-commands.md](./docs/slash-commands.md) — every `/command` and what it does
- [docs/hotkeys.md](./docs/hotkeys.md) — keybindings
- [docs/headless.md](./docs/headless.md) — non-TTY mode, exit codes, CI patterns
- [docs/skills.md](./docs/skills.md) — reusable instruction sets, scopes, frontmatter reference, invocation
- [docs/web-fetch.md](./docs/web-fetch.md) — WebFetch tool, bounds, per-domain whitelist
- [docs/troubleshooting.md](./docs/troubleshooting.md) — common issues and fixes
- [docs/observability.md](./docs/observability.md) — session-log JSONL schema
- [docs/security.md](./docs/security.md) — built-in path jail, bash deny list, env scrubbing
- [ARCHITECTURE.md](./ARCHITECTURE.md) — module map, data flow, design overview
- [CONTRIBUTING.md](./CONTRIBUTING.md) — dev setup, conventions, adding a provider

## Quick reference

```bash
factory --version                                    # print version
factory --help                                       # full flag list
factory                                              # interactive picker
factory -p anthropic -m claude-sonnet-4-6            # one-shot
factory --plan                                       # plan mode
factory --pick                                       # force startup picker
factory --turn-timeout 120                           # auto-abort after 120s
factory --debug                                      # debug logs to stderr
echo "explain src/index.ts" | factory                # headless / non-TTY
```

Once running, type `/help` to see the full slash-command list.

## Security

Built-in path jail, bash deny list, env scrubbing for subprocess execution, and plan mode for untrusted models. See [docs/security.md](./docs/security.md) for what's enforced and how to extend it, and [SECURITY.md](./SECURITY.md) for the disclosure process.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
