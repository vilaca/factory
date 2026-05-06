/**
 * Strict prefix allow-list for the Bash tool when invoked from a Delegate
 * subagent. The subagent is supposed to be read-only; even though Read/Glob/
 * Grep cover most investigation, models reflexively reach for Bash. We can't
 * remove Bash entirely without crippling them, so we whitelist a small set of
 * read-shaped command prefixes and reject anything else at dispatch time.
 *
 * The matcher is intentionally simple: we tokenize the command on whitespace
 * (respecting quotes), then check that the leading token sequence starts with
 * one of the allow-list entries. Compound commands (`&&`, `||`, `;`, `|`,
 * backticks, `$()`) are rejected outright — once a shell metacharacter is in
 * play, prefix-matching is no longer a meaningful guarantee.
 */

/** Each entry is a sequence of tokens that the command must start with. */
const ALLOWED_PREFIXES: readonly string[][] = [
  ['ls'],
  ['cat'],
  ['head'],
  ['tail'],
  ['wc'],
  ['find'],
  ['grep'],
  ['rg'],
  ['git', 'log'],
  ['git', 'diff'],
  ['git', 'show'],
  ['git', 'status'],
  ['git', 'branch'],
  ['git', 'ls-files'],
  ['npm', 'ls'],
  ['node', '--version'],
  ['which'],
  ['file'],
  ['awk'],
  ['sed', '-n'],
];

/**
 * Shell metacharacters that compose multiple commands or interpolate output.
 * If any of these appear in the raw command (outside quoted strings), we
 * reject — a prefix allow-list cannot reason about them safely.
 */
const COMPOUND_CHARS = ['&&', '||', ';', '|', '`', '$('];

export interface AllowDecision {
  allowed: boolean;
  /** Populated when allowed=false: a short user-readable explanation. */
  reason?: string;
}

/** Tokenize on whitespace, respecting single + double quotes. Returns null
 *  when quoting is malformed (which we treat as a rejection). */
export function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (quote) return null;
  if (current) tokens.push(current);
  return tokens;
}

/** Returns true when `command` matches one of the allowed prefix sequences
 *  AND contains no shell composition metacharacters outside quotes. */
export function isCommandAllowed(command: string): AllowDecision {
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: false, reason: 'empty command' };
  }

  // Reject compound shells before tokenization: `echo a; rm -rf b` would
  // otherwise tokenize as ['echo', 'a;', 'rm', ...] and the prefix would
  // pass.
  for (const meta of COMPOUND_CHARS) {
    // Quick check on the raw string. False positives inside quoted strings
    // are acceptable here — a subagent has no reason to embed `&&` inside a
    // quoted argument for the small set of read commands we allow.
    if (trimmed.includes(meta)) {
      return {
        allowed: false,
        reason: `compound shell construct not allowed in subagent: "${meta}"`,
      };
    }
  }
  // Redirection is also a write operation — block it.
  if (/[<>]/.test(trimmed)) {
    return {
      allowed: false,
      reason: 'shell redirection not allowed in subagent',
    };
  }

  const tokens = tokenizeCommand(trimmed);
  if (!tokens) {
    return { allowed: false, reason: 'malformed quoting in command' };
  }

  for (const prefix of ALLOWED_PREFIXES) {
    if (tokens.length < prefix.length) continue;
    let match = true;
    for (let i = 0; i < prefix.length; i++) {
      if (tokens[i] !== prefix[i]) {
        match = false;
        break;
      }
    }
    if (match) return { allowed: true };
  }

  return {
    allowed: false,
    reason: `command "${tokens[0] ?? ''}" is not in the subagent allow-list`,
  };
}

/** Exposed for help text / introspection. */
export function describeAllowList(): string {
  return ALLOWED_PREFIXES.map(p => p.join(' ')).join(', ');
}
