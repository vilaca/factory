# Architecture Decision Records

This directory holds the project's Architecture Decision Records (ADRs). An ADR captures **one architectural decision**, the context that forced it, and its consequences. ADRs are immutable once `Accepted` — to change a decision, write a new ADR that supersedes the old one.

## When to write an ADR

Write one before merging a change that:

- alters an invariant documented in [ARCHITECTURE.md](../../ARCHITECTURE.md), `src/security/`, or the `core/agent/` loop;
- introduces a new cross-cutting concern (a new tool category, a new policy hierarchy, a new artifact the agent consumes);
- contradicts or supersedes a prior ADR.

PRs that fit any of the above must reference the ADR number in the description. PRs that *don't* warrant an ADR usually shouldn't be touching those areas at all.

## Conventions

- **Filename:** `NNNN-kebab-title.md`, numeric prefix zero-padded to four digits.
- **Status:** `Proposed` → `Accepted` → optionally `Deprecated` or `Superseded`. Once `Accepted`, the body is frozen except for the `Status` header and a `Superseded-by:` line.
- **Date:** the date the ADR was written, not the date the decision was originally made. Retroactive ADRs (documenting decisions already encoded in the codebase) share their bootstrap date.
- **Supersession:** a superseding ADR carries a `Supersedes: NNNN` header; the superseded ADR is updated only to add `Superseded-by: NNNN`.
- **Length:** short. One screen of text is the target. If the rationale needs more, link to an external doc rather than expanding inline.
- **Index:** each ADR commit adds its own row to the index below. Reserved future numbers are not pre-listed.

## Template

Copy this for new ADRs.

```markdown
# NNNN — <Title>

- **Status:** Proposed
- **Date:** YYYY-MM-DD
- **Supersedes:** —
- **Superseded-by:** —

## Context

What forces this decision? Constraints, prior art, the problem the current state creates.

## Decision

The single architectural choice, stated as a present-tense imperative. One paragraph.

## Consequences

What becomes easier, what becomes harder, what invariants future contributors must preserve.
Include the load-bearing parts of the codebase that now depend on this decision.
```

## Index

| #   | Title | Status |
| --- | ----- | ------ |
| [0001](0001-no-cyclic-imports.md) | No cyclic imports anywhere under `src/` | Accepted |
| [0002](0002-core-independent-of-ui-and-cli.md) | `src/core/` has no dependency on `src/ui/` or `src/cli/` | Accepted |
| [0003](0003-security-and-utils-are-primitive-layers.md) | `src/security/` and `src/utils/` are primitive layers with no sibling deps | Accepted |
| [0004](0004-providers-independent-of-ui-and-tools.md) | `src/providers/` has no dependency on `src/ui/` or `src/tools/` | Accepted |
| [0005](0005-openai-adapter-is-internal-to-providers.md) | `src/providers/openai/` is an internal adapter — no external importers | Accepted |
| [0006](0006-mcp-and-ui-mutually-isolated.md) | `src/mcp/` and `src/ui/` must not import each other | Accepted |
| [0007](0007-headless-must-not-depend-on-tui.md) | `src/ui/headless.ts` must not depend on the TUI tree | Accepted |
| [0008](0008-ui-is-presentation-only.md) | `src/ui/` is a presentation layer (no concrete providers/tools, no SDKs, no direct network) | Accepted |
| [0009](0009-provider-abstraction-shared-openai-adapter.md) | Provider abstraction with a shared OpenAI-compatible adapter | Accepted |
| [0010](0010-two-tier-rotation.md) | Two-tier rotation: per-key, then per-`provider:model` tuple | Accepted |
| [0011](0011-agent-event-contract.md) | `AgentEvent` as the single contract between core loop and renderers | Accepted |
