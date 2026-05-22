# 0010 — Two-tier rotation: per-key, then per-`provider:model` tuple

- **Status:** Accepted
- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

Two failure modes routinely interrupt a long-running agent turn against cloud providers: a single API key hitting a rate limit (or its auth silently expiring), and an entire `provider:model` tuple becoming unusable (model deprecated, account suspended, regional outage). Treating them with one mechanism — "switch to the next thing" — conflates a transient, per-key event with a structural one and produces the wrong UX in both directions: a rate-limited key tears the user off the model they chose, and a dead model burns through every saved key before falling back.

The classification has to happen at the provider-error layer because each provider expresses these conditions with its own status codes and message shapes (Anthropic's `rate_limit_error`, Copilot's auth refresh, OpenAI 429 vs 401).

## Decision

Rotation is two-tiered. When the model call fails, `provider-errors.ts` classifies the error into one of three buckets: retryable-transient (handled by `provider-retry`), per-key (rate limit, auth) which advances the in-tuple key cursor in `call-model-rotation.ts`, or per-tuple (model gone, account suspended) which walks the user-configured `<provider>:<model>` fallback chain. Within a tuple, all keys are tried before the tuple is declared exhausted; only then does the chain advance. Exhaustion at either tier emits a distinct event (`key-rotation`, `key-rotation-exhausted`, `tuple-rotation`, `tuple-rotation-exhausted`) so renderers can show "swapping key" versus "frontier → fast" differently.

## Consequences

**Easier.**

- Users can save multiple keys per provider and have factory exhaust them before falling back to a different model class.
- The fallback chain (frontier → fast → free) survives a single key going bad; conversely, a dead model doesn't burn through good keys.
- Adding a new transient/permanent error pattern is one entry in `provider-errors.ts`, not a change across every provider file.

**Harder.**

- The classifier is now a load-bearing piece of the agent loop. A misclassified error (transient labeled as auth, or per-tuple labeled as per-key) produces either thrashing or premature surrender. Tests in `test/unit/providers/` for each provider's error shapes are the safety net; new providers need them.
- The rotation events are part of the `AgentEvent` contract. Renderers must handle all four; headless maps them to stderr notices.

**Invariants future contributors must preserve.**

- The classifier in `provider-errors.ts` is the single source of truth for what counts as rotate-worthy. Tools and tool dispatch must not catch and re-emit provider errors in a way that bypasses it.
- Tuple-rotation never demotes a key permanently — the saved-key store is preserved across the rotation event so a transient outage doesn't lose credentials.
