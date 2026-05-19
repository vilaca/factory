# Sampling parameters

Status: design notes for extending factory's per-request LLM controls. Captures what's wired today, what the underlying vendor APIs would accept, and a staged proposal for plumbing more knobs through.

## What's wired today

The cross-provider request surface is [`ChatOptions`](../src/providers/types.ts) and currently exposes only:

```ts
interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  cacheTools?: boolean;
  responsesChain?: { lastResponseId: string; messageCount: number };
  // …non-sampling fields elided
}
```

Nothing else (top-p, stop sequences, frequency/presence penalty, top-k, seed) is part of the type, so nothing reaches any provider — even when the vendor API would accept it.

### How the two existing knobs flow through

| Provider (file)                                    | Forwards `maxTokens`                                | Forwards `temperature`              |
| -------------------------------------------------- | --------------------------------------------------- | ----------------------------------- |
| Anthropic (`anthropic.ts`)                         | `max_tokens` (default 8192)                         | ✗ (ignored)                         |
| OpenAI (`openai/messages.ts`)                      | `max_completion_tokens` / `max_tokens`              | ✓                                   |
| Ollama (`ollama.ts`)                               | `options.num_predict` (default 4096)                | ✗ (ignored)                         |
| llama.cpp (`llamacpp.ts`)                          | via shared OpenAI builder                           | via shared OpenAI builder           |
| HuggingFace (`huggingface.ts`)                     | `max_tokens` (default 4096)                         | ✗ (ignored)                         |
| Copilot (`copilot/`)                               | via shared OpenAI builder                           | via shared OpenAI builder           |
| OpenRouter (`openrouter.ts`)                       | via shared OpenAI builder                           | via shared OpenAI builder           |
| Vercel AI Gateway (`vercel.ts`)                    | via shared OpenAI builder                           | via shared OpenAI builder           |
| Google AI Studio (`googleaistudio/`)               | via shared OpenAI builder                           | via shared OpenAI builder           |
| Mistral / Codestral (`mistral.ts`)                 | via shared OpenAI builder                           | via shared OpenAI builder           |
| Cerebras (`cerebras.ts`)                           | via shared OpenAI builder                           | via shared OpenAI builder           |
| Groq (`groq.ts`)                                   | via shared OpenAI builder                           | via shared OpenAI builder (0→1e-8)  |
| Cohere (`cohere.ts`)                               | `max_tokens`                                        | `temperature`                       |
| Workers AI (`workersai.ts`)                        | via shared OpenAI builder                           | via shared OpenAI builder (0→1e-8)  |
| OpenCode Zen → Anthropic (`opencodezen/anthropic.ts`) | `max_tokens`                                      | ✗ (ignored)                         |
| OpenCode Zen → Google (`opencodezen/google.ts`)    | `generationConfig.maxOutputTokens`                  | `generationConfig.temperature`      |

The `buildChatBody` helper in [`openai/messages.ts`](../src/providers/openai/messages.ts) is the high-leverage spot — touching it lights up nine providers at once. Anthropic, Ollama, Cohere, and the OpenCode Zen sub-adapters each need their own one-liner.

### Provider-specific quirks already in the codebase

- **Groq and Workers AI** reject `temperature === 0` with a 400. Both substitute `1e-8` before sending.
- **Tool-call corrector** (`src/core/agent/tool-calls/tool-call-corrector.ts:61`) pins `temperature: 0` — repair has to be deterministic.
- Everywhere else, `temperature` is left undefined and each provider's server-side default applies.

## What each vendor API would accept

`✓` = native support, `~` = partial / model-dependent, `✗` = not supported.

| Vendor API                          | `top_p` | `top_k` | `stop` / `stop_sequences` | `frequency_penalty` | `presence_penalty` | `seed` |
| ----------------------------------- | :-----: | :-----: | :-----------------------: | :-----------------: | :----------------: | :----: |
| OpenAI Chat Completions (gpt-4o etc.) | ✓     | ✗       | ✓                         | ✓                   | ✓                  | ✓      |
| OpenAI Responses — reasoning models   | ✗     | ✗       | ~                         | ✗                   | ✗                  | ✓      |
| Anthropic Messages                   | ✓       | ✓       | ✓ `stop_sequences`        | ✗                   | ✗                  | ✗      |
| Ollama `/api/chat`                   | ✓       | ✓       | ✓ `options.stop[]`        | ✓                   | ✓                  | ✓      |
| llama.cpp (OpenAI-compat + extras)   | ✓       | ✓       | ✓                         | ✓                   | ✓                  | ✓      |
| HuggingFace Inference (router)       | ✓       | ~       | ✓                         | ✓                   | ✓                  | ✓      |
| GitHub Copilot                       | ✓       | ✗       | ✓                         | ✓                   | ✓                  | ~      |
| OpenRouter                           | ✓       | ✓       | ✓                         | ✓                   | ✓                  | ✓      |
| Vercel AI Gateway                    | ~       | ~       | ~                         | ~                   | ~                  | ~      |
| Google AI Studio (OpenAI-compat)     | ✓       | ✗       | ✓                         | ✓                   | ✓                  | ~      |
| Google AI Studio (native Gemini)     | ✓ `topP`| ✓ `topK`| ✓ `stopSequences`         | ✓                   | ✓                  | ✓      |
| Mistral / Codestral                  | ✓       | ✗       | ✓                         | ✓ (new models)      | ✓ (new models)     | ✓      |
| Cerebras                             | ✓       | ✗       | ✓                         | ✗                   | ✗                  | ✓      |
| Groq                                 | ✓       | ✗       | ✓                         | ✓                   | ✓                  | ✓      |
| Cohere `/v2/chat`                    | ✓ `p`   | ✓ `k`   | ✓ `stop_sequences`        | ✓                   | ✓                  | ✓      |
| Workers AI                           | ✓       | ~       | ✓                         | ~                   | ~                  | ~      |
| OpenCode Zen → Anthropic             | ✓       | ✓       | ✓                         | ✗                   | ✗                  | ✗      |
| OpenCode Zen → Google                | ✓       | ✓       | ✓                         | ~                   | ~                  | ~      |

### Tier-aware caveats

Some of those `✓`s are conditional on model tier:

- **Anthropic Claude 4.x with extended thinking** — `temperature` must be `1.0`; `top_p` and `top_k` are forbidden (API returns 400).
- **OpenAI o-series and gpt-5 reasoning models** — `temperature`, `top_p`, `frequency_penalty`, `presence_penalty` are silently ignored.
- **Gemini 2.5 with thinking budget** — sampling knobs partly degraded.
- **Cerebras** — penalty parameters not in their public surface.
- **Ollama** — every parameter is accepted on the wire, but quantized/older builds may ignore values silently.

## Proposed extension

Staged from "minimal useful slice" to "full control surface". Each stage stands alone.

### Stage 1 — wire `temperature` through every provider, add a `--temperature` flag

The smallest change that moves the needle for coding workflows.

1. Add Anthropic / Ollama / HuggingFace / OpenCode-Zen-Anthropic to the temperature-forwarders. Each is a one-liner next to the existing `maxTokens` plumbing.
2. Add CLI flag `--temperature <0..2>` parsed in [`src/cli/args.ts`](../src/cli/args.ts), threaded through `appOptions` like the existing `--turn-timeout`.
3. Add `agent.sampling.temperature` to the config schema and merge under standard precedence (global → project → CLI).

Tradeoff: coding-agent turns rarely benefit from a non-default `temperature`. This is mostly a power-user knob. Worth doing because it's almost free.

### Stage 2 — extend `ChatOptions` with the rest of the standard sampling set

Add to the type:

```ts
interface ChatOptions {
  // existing
  maxTokens?: number;
  temperature?: number;
  // new
  topP?: number;
  topK?: number;
  stop?: string[];
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
}
```

Plumb through:

- **`buildChatBody`** (one edit, covers OpenAI / OpenRouter / Vercel / Google AI Studio / Mistral / Codestral / Cerebras / Groq / Workers AI / Copilot / llama.cpp).
- **Anthropic** — `top_p`, `top_k`, `stop_sequences` only. Silently drop `frequencyPenalty` / `presencePenalty` / `seed`.
- **Ollama** — map every field into `options.{top_p,top_k,stop,frequency_penalty,presence_penalty,seed}`.
- **Cohere** — map `topP → p`, `topK → k`, plus `stop_sequences`, `frequency_penalty`, `presence_penalty`, `seed`.
- **OpenCode Zen (Anthropic)** — same subset as Anthropic.
- **OpenCode Zen (Google)** — map into `generationConfig.{topP,topK,stopSequences,frequencyPenalty,presencePenalty,seed}`.
- **HuggingFace** — forward via the underlying OpenAI-shaped body the SDK builds.

Surface to the user via config (`agent.sampling.*`) and CLI flags (`--top-p`, `--top-k`, `--stop`, `--frequency-penalty`, `--presence-penalty`, `--seed`). Match the existing flag style — long-form only, simple values, no aliases.

Tradeoff: more surface area to keep tested. Reasoning-model carve-outs (next stage) become more important.

### Stage 3 — tier-aware filtering via `ProviderCapabilities`

Extend [`ProviderCapabilities`](../src/providers/types.ts) with a `samplingSupport` field per model:

```ts
interface ProviderCapabilities {
  // existing
  contextWindow: number;
  maxOutputTokens: number;
  toolSupport: ToolSupport;
  parallelToolCalls: boolean;
  streaming: boolean;
  tokenCounting: TokenCounting;
  modelTier: ModelTier;
  // new
  samplingSupport: {
    temperature: 'ignored' | 'fixed-1' | 'accepted';
    topP: 'forbidden' | 'accepted';
    topK: 'forbidden' | 'accepted';
    stop: 'accepted' | 'unsupported';
    penalties: 'accepted' | 'unsupported';
    seed: 'accepted' | 'unsupported';
  };
}
```

Each provider's `getCapabilities(model)` returns the per-model truth. The request layer reads `samplingSupport` and either silently drops or substitutes (`fixed-1` for Claude thinking-mode temperature) before sending. The Groq / Workers AI `0 → 1e-8` workaround moves out of the provider files and into this generic substitution layer.

Tradeoff: every provider gets a small lookup table. Pays for itself by making "why is my `temperature` not working on this model" debuggable from one place.

### Stage 4 — per-tab sampling overrides

Each tab already carries its own `ChatOptions` via `RunRefs`. Wire a `/temperature 0.7` style slash command and a `/sampling` TUI panel so per-tab overrides don't require restarting. Stage 4 is gated on actual demand — most coding-agent flows are happy with one global setting.

## Non-goals

- **OpenAI `logit_bias`** — token-level steering is rarely useful for tool-using agents and adds tokenizer dependencies.
- **`response_format` / structured outputs** — handled at the tool-call layer, not the sampling layer.
- **`n` / multiple completions** — the agent loop assumes a single response stream.
- **Provider-exotic knobs** (OpenRouter `min_p`, `top_a`, `repetition_penalty`; Ollama `mirostat`, `tfs_z`) — keep them out of the cross-provider surface; if you need them, edit the provider file directly.

## Touch list (Stage 1 + 2)

For the maintainer who picks this up:

```
src/providers/types.ts                          ChatOptions fields
src/providers/openai/messages.ts                buildChatBody — single edit, 9 providers
src/providers/anthropic.ts                      top_p / top_k / stop_sequences
src/providers/ollama.ts                         options.* mapping
src/providers/cohere.ts                         p / k / stop_sequences / penalties
src/providers/huggingface.ts                    temperature + top_p + stop + penalties
src/providers/opencodezen/anthropic.ts          same as anthropic.ts subset
src/providers/opencodezen/google.ts             generationConfig.* mapping
src/cli/args.ts                                 new flags + parsing
src/cli/startup/config.ts                       merge agent.sampling.* under precedence rules
src/core/config/validate.ts                     validate the new section
src/core/config/types.ts                        agent.sampling: SamplingConfig
test/unit/providers/*.test.ts                   one body-assertion per provider
test/unit/core/config/config.test.ts            sampling validation
```
