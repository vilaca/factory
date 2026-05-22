# 0022 — Subagent isolation: separate conversation + restricted Bash allowlist

- **Status:** Accepted
- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

Delegation is the single largest capability gap separating factory from frontier coding agents (`IDEAS.md` M1, `feat/subagent-delegate`). The delegating-agent's context is precious: spending 30k tokens on a code search wastes the budget of the *main* task. The right shape is to spawn a sub-agent with its own clean context, let it do the work, and return only the summary.

But a sub-agent that inherits the full tool surface — especially `Bash` with `rm`, `git push`, `curl` — is a different security problem from the main agent. The main agent is interactive: the user sees and approves each call. A sub-agent runs autonomously by design; any tool surface it has is a tool surface the user has not pre-approved individually.

## Decision

Sub-agents run in `src/core/subagent/runner.ts` with two isolation properties:

1. **Independent conversation.** The sub-agent gets a fresh `Conversation`. It does not see the parent's history; the parent does not see the sub-agent's intermediate tool calls. Only the sub-agent's final summary returns to the parent as a tool-result.
2. **Restricted Bash allowlist** (`src/core/subagent/bash-allowlist.ts`). The sub-agent's Bash policy is *narrower* than the main agent's: an explicit allowlist of read-only investigation commands (`grep`, `find`, `git log`, `ls`, etc.), not the main agent's "deny only what's hostile" approach.

The delegate tool itself is gated by the experimental `subagents` flag; the design above is what the flag opts into.

## Consequences

**Easier.**

- A sub-agent is a context-savings device by construction. The user's main turn doesn't pay for the sub-agent's exploration.
- Parallel sub-agents (M3) become natural — they don't share conversation state with each other or the parent, so fan-out is just "spawn N runners and join".
- The sub-agent's surface is small enough to reason about. A new sub-agent tool requires an explicit allowlist entry.

**Harder.**

- The summary is now load-bearing. A bad summary means the parent acts on wrong information. The summary contract (what fields, what fidelity) is the sub-agent equivalent of the compaction summary in [ADR 0015](0015-context-compaction.md) — both warrant the same scrutiny.
- The Bash allowlist is conservative by design. Legitimate sub-agent tasks that need a non-allowlisted command must either (a) extend the allowlist with justification, or (b) escalate by returning a recommendation to the parent rather than executing.
- Cost: a sub-agent is a model call from scratch. For trivial questions the overhead outweighs the savings; the parent should not delegate work it can do in one or two of its own tool calls.

**Invariants future contributors must preserve.**

- A sub-agent's intermediate tool calls and intermediate model output never leak into the parent's conversation. Only the summary returns.
- The sub-agent Bash allowlist is *strictly narrower* than the main agent's bash rules. Loosening it requires an ADR (with the same logic as [ADR 0013](0013-builtin-security-rules-not-user-overridable.md)'s "additive only" rule for built-ins).
- Sub-agent runners do not write to disk except via tools that already pass through `src/security/`. The runner itself is not a privileged actor.
