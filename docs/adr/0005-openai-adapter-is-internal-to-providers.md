# 0005 — `src/providers/openai/` is an internal adapter — no external importers

- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

The shared OpenAI-compatible adapter under `src/providers/openai/` owns SSE parsing, streaming-chunk handling, tool-call accumulation, and usage extraction. It's the shared backbone for the seven flat-file providers (cerebras, groq, mistral, openrouter, vercel, llamacpp, workersai) and three folder-with-own-auth ones (copilot, googleaistudio, opencodezen). See [ADR 0009](0009-provider-abstraction-shared-openai-adapter.md) for why the shared adapter exists in the first place.

The adapter is *internal*: it has no entry in `src/providers/registry.ts` and is not selectable by name. The risk it manages is a slow drift where, say, a UI helper or the agent loop's parser starts importing from `openai/` directly because "it's right there." Each such importer pins the adapter to additional surface area beyond providers, which is exactly the indirection the adapter was meant to avoid.

## Decision

Only files under `src/providers/**` may import from `src/providers/openai/**`. Every other module — `src/core/`, `src/tools/`, `src/ui/`, `src/cli/`, `src/mcp/`, `src/security/`, `src/utils/`, plus other sibling `src/` folders — is forbidden from importing the adapter.

Enforced in `test/unit/arch/modularity.test.ts` with `projectFiles().inFolder('src/**', { except: 'src/providers/**' }).shouldNot().dependOnFiles().inFolder('src/providers/openai/**')`.

## Consequences

**Easier.**

- The adapter is free to evolve: changing an internal helper signature only requires checking the ten provider files that consume it, not the entire codebase.
- The "no `openai` entry in `registry.ts`" rule has a partner now — even if someone adds a registry entry by mistake, the test catches the broader leak.
- When debugging a provider issue, the search radius is bounded: the provider file plus the adapter, nothing else.

**Harder.**

- A future utility that *is* genuinely about SSE parsing (not about chat completions specifically) must live somewhere else — `src/utils/` if framework-free, or its own folder. It cannot graduate to `openai/` just for convenience.
- Splitting `openai/` later (e.g. extracting a pure SSE library) requires moving the extracted bits *out* of `providers/openai/`, not loosening the import rule.

**Invariants future contributors must preserve.**

- `src/providers/openai/` has no entry in `registry.ts`. Adding one is the start of an architectural drift.
- A file outside `src/providers/` importing from `openai/` is a test failure. Treat as a real architectural violation, not a "just add an exception."
