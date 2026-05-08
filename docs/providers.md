# Providers

factory supports 15 providers. Each one ships with default model discovery, capability inference, and (where the SDK supports it) tool-call streaming.

## Provider matrix

| Provider | CLI alias | Auth | Notes |
| -------- | --------- | ---- | ----- |
| Anthropic Claude | `anthropic`, `claude` | `ANTHROPIC_API_KEY` | Native protocol; explicit prompt caching supported. |
| Cerebras | `cerebras` | `CEREBRAS_API_KEY` | OpenAI-compatible; very fast inference. |
| Codestral | `codestral` | `CODESTRAL_API_KEY` | Mistral's code-focused endpoint. Same SDK as Mistral. |
| Cohere | `cohere` | `COHERE_API_KEY` | Native protocol. Streaming not yet implemented (uses non-streaming chat). |
| GitHub Copilot | `copilot` | `GITHUB_COPILOT_API_KEY` or `COPILOT_API_KEY`, or interactive OAuth | Catalog reflects Copilot's own picker/policy flags. |
| Google AI Studio | `googleaistudio`, `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY`, or `GOOGLE_APPLICATION_CREDENTIALS` (ADC), or `gcloud auth application-default login` | Filters out non-chat models (embeddings, image/video, TTS). |
| Groq | `groq` | `GROQ_API_KEY` | OpenAI-compatible. Excludes audio/guardrail models. |
| HuggingFace | `huggingface`, `hf` | `HF_TOKEN` or `HUGGING_FACE_HUB_TOKEN` | Curated starter list of chat models; HF doesn't expose a single "chat models I can use" catalog. |
| llama.cpp | `llamacpp` | none (local) | Lists the currently loaded model set from the llama.cpp server. |
| Mistral | `mistral` | `MISTRAL_API_KEY` | OpenAI-compatible. |
| Ollama | `ollama` | none (local) or token via `--token` | Default; assumes `http://localhost:11434`. |
| OpenCode Zen | `opencodezen` | `OPENCODE_ZEN_API_KEY` or `OPENCODE_API_KEY` | Routes to Anthropic-, Google-, or OpenAI-shaped backends per model. GPT models routed via the legacy chat-completions path; native `/responses` is on the roadmap. |
| OpenRouter | `openrouter`, `or` | `OPENROUTER_API_KEY` | OpenAI-compatible; preserves Anthropic `cache_control` blocks for `anthropic/...` model ids. |
| Vercel AI Gateway | `vercel` | `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` | OpenAI-compatible. Filters to language models only. |
| Workers AI | `workersai` | `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`) | OpenAI-compatible. Cloudflare account ID can also be inferred from the host URL. |

## Auth precedence

For every provider:

1. CLI `--token` takes precedence.
2. Then the env var(s) listed above.
3. Then a key entry from the config file (`keys.<provider>[].token`). Multiple entries enable key rotation — see `/keys` for the saved set and `/rotate` for the active chain.
4. Then an interactive prompt if the picker is on the screen.

## Model discovery

Most providers expose `/v1/models` and factory paginates through it. Some quirks:

- **Anthropic** uses a curated allowlist instead of a live list (the public catalog is broader than what we want to surface in a CLI picker).
- **HuggingFace** has no "models I can use with this token" endpoint — uses a curated starter list.
- **Workers AI** uses Cloudflare's `models/search` endpoint and filters to `text generation` tasks.
- **Google AI Studio** filters out non-chat methods (`embedding`, `imagen`, `veo`, `lyria`, `tts`, `speech`, `music`, `image`, `video`, `live`).

## Tool support

| Level | Description |
| ----- | ----------- |
| `native` | Provider exposes a tool-call API; tool calls round-trip through structured fields. |
| `basic` | Tool calls are supported but with limitations (no parallel calls, no reasoning preservation). |
| `none` | No structured tool support; the agent falls back to text-based tool calls (recovered by `core/text-tool-parser.ts`). |

Per-model capability is reported by `getCapabilities(model)` on each provider — see `src/providers/<provider>.ts`.

## Examples

```bash
factory --provider anthropic --model claude-sonnet-4-6
factory -p copilot -m gpt-4.1
factory -p ollama -m qwen2.5-coder
factory -p googleaistudio -m gemini-2.5-pro
factory -p workersai -m '@cf/qwen/qwen2.5-coder-32b-instruct'
factory --host http://remote:11434                  # remote Ollama
factory -p llamacpp --host http://localhost:8080    # local llama.cpp server
```
