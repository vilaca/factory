# 0008 — `src/ui/` is a presentation layer: no concrete providers, tools, SDKs, or direct network

- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

The UI's job is to *render* what the agent loop produces. Everything else — talking to an LLM, executing a tool, opening a socket, spawning a subprocess — happens in `src/core/`, `src/providers/`, `src/tools/`, or `src/mcp/`. Drift across this boundary is gradual and very tempting: a "quick" import of `anthropic-ai/sdk` to show a richer error message; a `node:http` ping to check connectivity; importing a concrete tool's helper for nicer formatting. Each is small and locally justifiable; in aggregate they make the UI impossible to test without a network and turn renderer regressions into provider bugs.

A second renderer (`headless.ts`) and future ones (ACP server, eval harness) compound the cost: every cross-boundary import is one more thing that breaks renderer interchangeability.

## Decision

`src/ui/**` must not:

1. **Depend on concrete provider implementations.** Only `src/providers/types.ts`, `src/providers/registry.ts`, and `src/providers/descriptors.ts` are reachable — i.e. the typed registry surface, not the implementations.
2. **Depend on concrete tool handler files.** Only `src/tools/types.ts`, `src/tools/registry.ts`, and `src/tools/index.ts` are reachable.
3. **Import LLM/network SDK packages directly.** The deny list includes `@anthropic-ai/sdk`, `@huggingface/inference`, `@modelcontextprotocol/sdk`, `ollama`, and `google-auth-library`. All LLM calls route through `src/providers/registry`.
4. **Import Node networking or child-process modules directly.** The deny list covers `http`, `https`, `net`, `dgram`, `child_process` and their `node:` prefixed forms. All HTTP and process I/O routes through `src/providers/` (LLMs) or `src/tools/` (Bash, etc.).

Enforced by four ArchUnit rules in `test/unit/arch/modularity.test.ts` (`shouldNot().dependOnFiles()` for the two folder restrictions, `.should().adhereTo(predicate)` for the SDK and Node-module checks scanning import strings).

## Consequences

**Easier.**

- The UI is testable without spinning up a network or mocking provider SDKs — the registry surface is the only seam.
- A new renderer (ACP server, eval harness) inherits the same boundary by being added under `src/ui/` or as a peer of `headless.ts`.
- A bug that's "I/O-shaped" is always in `providers/`, `tools/`, `mcp/`, or `core/` — never in the UI. Reduces search radius dramatically.

**Harder.**

- A UI that legitimately needs to fetch something (e.g. a status check, a help-doc download) has to go through a tool — usually `WebFetch` — rather than `node:https`. This is the right answer: the security layer (path/domain/etc.) applies, and the tool is testable.
- Showing provider-specific details in the UI requires either threading more data through `descriptors.ts` or emitting an `AgentEvent` that carries it. The renderer cannot read the SDK to find out.

**Invariants future contributors must preserve.**

- The "registry-only" exceptions for providers and tools are intentional and minimal. Adding more exception entries should require a separate ADR.
- The Node-module deny list scales: any new transport primitive that lands in Node (a future `node:quic`, for example) joins the deny list.
- The four rules are independent — keep them as four rules, not one combined check, so a violation says exactly which boundary cracked.

## Enforcement

Four `it(...)` blocks in `test/unit/arch/modularity.test.ts` fail CI if `src/ui/**` crosses any of these boundaries. The test name maps to the rule and to the deny list:

- **Rule 1 — concrete provider imports.** Test: `src/ui/** must not import concrete provider implementations (only types/registry/descriptors)`. Allowed under `src/providers/**`: `types.ts`, `registry.ts`, `descriptors.ts`. Everything else in `src/providers/**` is denied.
- **Rule 2 — concrete tool imports.** Test: `src/ui/** must not import concrete tool handler files (only types/registry/index)`. Allowed under `src/tools/**`: `types.ts`, `registry.ts`, `index.ts`. Everything else is denied.
- **Rule 3 — LLM/network SDKs.** Test: `src/ui/** must not import network SDK packages directly`. Denied: `@anthropic-ai/sdk`, `@huggingface/inference`, `@modelcontextprotocol/sdk`, `ollama`, `google-auth-library`.
- **Rule 4 — Node networking / child-process modules.** Test: `src/ui/** must not import node networking or child-process modules directly`. Denied (both bare and `node:`-prefixed): `http`, `https`, `net`, `dgram`, `child_process`.

[ADR 0020](0020-manual-argv-parser.md) reuses the same deny-list shape for CLI parsing libraries. If a future ADR overturns one of the above, narrow the rule with an additional `except: [...]` entry rather than removing it.
