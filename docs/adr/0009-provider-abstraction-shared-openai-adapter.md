# 0009 — Provider abstraction with a shared OpenAI-compatible adapter

- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

factory supports 16 model providers on equal footing. A naive design would give every provider its own SSE parser, streaming chunk handler, tool-call accumulator, and usage extractor — at which point either (a) the same bug gets fixed 16 times, or (b) the bug only gets fixed in the provider somebody actually uses that week. Most cloud providers either *are* OpenAI-compatible or expose a near-identical Chat Completions surface; the small amount of divergence between them is in auth, defaults, and request-body quirks, not transport.

At the same time, a single mega-adapter would be wrong for the genuinely-native cases: Anthropic uses its own SDK with a different message shape; Ollama uses the `ollama` package; Cohere is hand-rolled because its response shape has never matched. Forcing those through an OpenAI-shaped adapter would either lose information or smuggle their quirks into the shared code path.

## Decision

Every provider implements the `Provider` interface in `src/providers/types.ts`. The shared adapter at `src/providers/openai/` owns SSE parsing, streaming chunk handling, tool-call accumulation, and usage extraction, and is **internal** — it has no entry in `src/providers/registry.ts` and cannot be selected by name. Providers slot into one of three flavors:

1. **Flat-file consumers of the shared adapter** — single `.ts` file that delegates streaming and tool-call handling to `openai/` via `buildChatBody` / `sendOpenAiChat` / `streamOpenAiChat`. Used by `cerebras`, `groq`, `mistral`, `openrouter`, `vercel`, `llamacpp`, `workersai`, and (for tool-call helpers only) `huggingface`.
2. **Folder-with-own-auth on the shared adapter** — uses `openai/` for transport but carries its own auth flow (`copilot/`, `googleaistudio/`, `opencodezen/`).
3. **Truly native** — parses its own response shapes and does not touch `openai/` (`anthropic.ts`, `ollama.ts`, `cohere.ts`).

The registry is the only public selector; the descriptor file (`descriptors.ts`) carries the per-provider metadata (label, aliases, env vars, default host) that the CLI/picker need.

## Consequences

**Easier.**

- Adding an OpenAI-compatible provider is a single file plus three lines of registry/descriptor wiring. `CONTRIBUTING.md` documents the path.
- Bug fixes in SSE handling, tool-call accumulation, or usage extraction land once and benefit every flat-file consumer.
- Provider-shape divergence is visible at the registry: a quick `git diff` of `providers/` answers “is this one native or shared?” without reading the implementation.

**Harder.**

- The shared adapter is now load-bearing. Changes to `openai/` must consider every consumer (currently 7 flat-file + 3 folder-with-own-auth). The dependency is one-way (providers depend on `openai/`, never the reverse), and that direction is the invariant — `openai/` must never reach into provider files.
- The native trio (`anthropic`, `ollama`, `cohere`) need their own SSE / streaming fixes when transport bugs land. This is the explicit trade: keeping the native shapes accurate beats forcing them through a lossy adapter.
- Future providers that are *almost* OpenAI-shaped but not quite (e.g. one extra wrapping field) tempt contributors to add a feature flag to the adapter. Prefer a folder-with-own-auth variant, or a thin wrapper around the shared helpers, over branching logic inside `openai/`.

**Invariants future contributors must preserve.**

- `openai/` has no entry in `registry.ts`.
- Provider files never import each other; cross-provider helpers live under `openai/` or `utils/`.
- The `Provider` interface is the only contract the agent loop knows about. New capabilities (e.g. multimodal, tool-call streaming variants) go on the interface, not on a subclass branch.
