# 0004 — `src/providers/` has no dependency on `src/ui/` or `src/tools/`

- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

A provider is the transport adapter for one LLM. Its job is narrow: take a `ChatBody` and a stream callback, talk HTTP / SDK, hand chunks back. The moment a provider knows about the *tool registry* (the concrete tool surface) or about the *UI*, it gains the ability to special-case its responses based on what tools are loaded or what renderer is running — and that turns provider files into per-call control logic. Two consequences: providers stop being substitutable, and bugs in one provider can hide in UI/tool coupling that doesn't show up in the others.

The agent loop already passes providers everything they need (the request body, the tools they'll be told about, the callback to stream into). They never need to ask the UI or pull from the tool registry directly.

## Decision

`src/providers/**` must not depend on `src/ui/**` or `src/tools/**`. Providers receive their inputs through the `Provider` interface in `src/providers/types.ts` and stream their outputs back through the call-model wrapper; they have no need (and no path) to reach into renderer state or tool implementations.

Enforced in `test/unit/arch/modularity.test.ts` via `projectFiles().inFolder('src/providers/**').shouldNot().dependOnFiles().inFolder('src/ui/**' | 'src/tools/**')`.

## Consequences

**Easier.**

- Providers are unit-testable in isolation against a fake `ChatBody` and an in-memory callback. No tool registry or UI shim is needed.
- A new provider implementation follows a clear shape: the `Provider` interface plus optional helpers from `src/providers/openai/` (see [ADR 0005](0005-openai-adapter-is-internal-to-providers.md)). It cannot accidentally inherit dependencies on renderers or tools.
- The substitution promise of the rotation chain (frontier → fast → free) is preserved because every provider speaks the same interface against the same inputs.

**Harder.**

- A provider that wants to surface a UI-specific signal (e.g. "this stream has a cost warning") emits it as part of its `Provider` return data, not by calling into the UI.
- Provider-specific tool quirks (some providers serialize tool calls oddly) are handled in the shared OpenAI adapter or in the agent loop's parser, not by the provider reading from the tool registry.

**Invariants future contributors must preserve.**

- Provider files import only from `src/providers/`, `src/utils/`, `src/security/`, Node built-ins, and `node_modules`. Nothing else.
- A provider that needs to know about a tool's *category* (read-only vs write) is using the wrong abstraction — that's the agent loop's job, not the provider's.
