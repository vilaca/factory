# 0013 — Built-in security rules cannot be user-overridden, only extended

- **Date:** 2026-05-18
- **Supersedes:** —
- **Superseded-by:** —

## Context

The security surface protects against two distinct populations: malicious or careless models, and user misconfiguration. The first population is the *raison d'être* of the path jail and bash deny list; the second is the reason the rules are not just docs. A user-overridable rule set defeats both: a model can be prompt-injected to write a config that "allows" `rm -rf /`, and a user copying a config from elsewhere can disable a built-in deny without realizing it. The class of bugs where "the user gave themselves permission to be exploited" is the most common failure mode in security-tool design.

At the same time, every repository is different, so the rule set must be extensible — additional denies and additional allow-paths per project are legitimate needs.

## Decision

The built-in rules in `src/security/paths.ts` (path jail deny list: `.ssh`, `.aws`, `.gnupg`, `/etc/shadow`, and the rest) and `src/security/bash-rules.ts` (forbidden patterns: `rm -rf /`, fork bomb, `curl|sh`, `dd to /dev/*`) are exported lists. User configuration is **additive only** — user globs and patterns are merged into the deny set; there is no syntax to *remove* a built-in entry. The same rule applies to `src/security/env.ts`: the deny-by-default scrub list cannot be widened to expose more env vars via config.

## Consequences

**Easier.**

- The security audit surface stays small: the built-in list is the floor, never the ceiling.
- A user-shared config can never weaken security. Worst case it adds friction by denying more.
- Reviewers checking a PR don't need to chase whether a config knob disables a check — there is no such knob.

**Harder.**

- A user with a legitimate need to read inside a normally-denied path (some build systems poke at `.gitconfig`) has to work *with* the system, not around it. Currently this means an explicit per-tool permission grant at the moment of access; future work may add a per-project allowlist scoped strictly to additive paths, but never to override a built-in deny like `.ssh`.
- The maintainers carry the burden of keeping the built-in list current. New attack patterns (a novel `curl … | bash` variant, a new shell metacharacter trick) need a built-in addition, not a config update.

**Invariants future contributors must preserve.**

- Built-in deny lists are exported constants. User config is parsed into additions, never subtractions.
- A user-config schema field that "disables" a built-in rule must be rejected at config validation.
- The same additive-only rule extends to any new security subsystem (validators, output checks). Make the floor non-negotiable from day one.
