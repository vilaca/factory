# 0018 — Hooks: sandboxed env, forbidden-command guard, first-run trust prompt

- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

User-configured shell hooks (pre/post tool-call, session start/end, etc.) are powerful and dangerous. They run with the user's privileges, so a hook script that pulls from an untrusted source — say, a teammate's shared config or a downloaded project's `.factory/` — can run arbitrary code. At the same time, hooks are essential to the "automate the boring parts" story: format-on-write, auto-test-after-edit, notification on long completion.

Re-using the agent's path jail and bash forbidden-pattern list wholesale is overkill: hooks are *user code*, not model output. The user is allowed to write a hook that `rm`s a file; what they need protection from is (a) inheriting a poisoned env that smuggles secrets, (b) running a hook they never approved, and (c) a small set of unambiguously hostile patterns (`rm -rf /`).

## Decision

Hook execution in `src/core/hooks/` enforces three layers:

1. **Sandboxed env** — hooks run with a scrubbed environment (the same `src/security/env.ts` deny-by-default approach) so a poisoned `LD_PRELOAD`, `PATH`, etc. from upstream config cannot bleed in. Safe-vars whitelist only.
2. **Forbidden-command guard** — a narrow built-in deny list (subset of `bash-rules.ts`) catches the small class of universally-hostile patterns. Narrower than the model-facing bash rules because the user is allowed more latitude than the model.
3. **First-run trust prompt** — `src/core/hooks/trust.ts` fingerprints the hook config (script command + matchers) and prompts the user on first sight. The fingerprint canonicalizes the config so equivalent reorderings don't re-prompt; any change to a hook re-triggers the prompt.

Hooks do not reuse the path-jail wholesale — they have their own narrower surface because their use cases (writing build artifacts, running tests in `node_modules/`) routinely cross the agent's jail.

## Consequences

**Easier.**

- Sharing a hook config with a teammate is safe by default — they get prompted before anything runs.
- Hooks can do legitimate work (format, test, notify) without contorting around the agent's stricter rules.
- Adding a new hook event is one entry in `discovery.ts` plus the fire site; the trust/sandbox machinery applies automatically.

**Harder.**

- The trust fingerprint is content-addressed. A subtle bug there is dangerous: collisions mean an untrusted hook runs without prompting; over-sensitivity means every minor edit re-prompts and trains the user to mash "yes". The canonicalization function is one of the highest-stakes pieces of code in the project and warrants property-based tests (M2).
- Hook surface is distinct from agent surface, which means two security audit targets, not one. They share helpers where they can (`env.ts` is reused) but diverge where the threat models diverge.

**Invariants future contributors must preserve.**

- A new hook event must fire through the same trust + sandbox machinery. Bypassing for "internal" reasons is the path to a confused-deputy bug.
- The forbidden-command guard for hooks is a *subset* of the model-facing bash rules. It must never widen past that subset — if the model-facing rules add a new ban, the hook rules either add it too or document explicitly why hooks are exempt.
- The trust fingerprint canonicalization must be deterministic across runs, OS, and shell. Test with structurally-equivalent reorderings producing identical fingerprints.
