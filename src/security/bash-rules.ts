// Bash command policy.
//
// Two layers:
//
//   1. **Built-in forbidden patterns** — hard-deny, no prompt, no override.
//      Matches commands that have no safe interpretation (rm -rf /, fork
//      bomb, curl|sh, dd to a raw device). Even an `allow-all` permission
//      cannot bypass these. This is the "safety net" so users who liberally
//      grant Bash access don't have a fully unguarded agent.
//
//   2. **User rules** — ordered list of {pattern, decision} pairs.
//      First match wins. Patterns are simple shell-style globs (`*`, `?`)
//      matched against the *raw* command string. Useful for "I'm fine with
//      `git status*` and `npm test*` but never `git push *`". Rules can be
//      added at runtime (saved to config on user request) or pre-populated
//      via config.json `permissions.bashRules`.
//
// Decision flow:
//   - forbidden? → DENY (explained to model; no user prompt)
//   - first matching user rule → its decision (allow / deny / prompt)
//   - bash auto-allowed via PermissionManager.allowAll? → ALLOW
//   - otherwise → PROMPT
//
// Why glob and not regex for user rules: globs are familiar from shell and
// from Claude Code's settings.json permissions. Regex is a footgun (a typo
// can over-grant). If a user truly needs regex they can compose multiple
// glob rules.

import { globToRegex } from '../utils/glob-match.js';

type BashDecision = 'allow' | 'deny' | 'prompt';

export interface BashRule {
  pattern: string;
  decision: BashDecision;
  /** Optional human-readable note shown in /permissions output. */
  note?: string;
}

export interface BashEvaluation {
  decision: BashDecision;
  /** When decision is 'deny', a message describing why — surfaced to the
   *  model as the tool result. */
  reason?: string;
  /** Which rule matched, for logging. 'forbidden:<id>' or 'user:<index>'
   *  or 'default'. */
  source: string;
}

interface ForbiddenPattern {
  id: string;
  test: (cmd: string) => boolean;
  reason: string;
}

// Built-in forbidden patterns. These are cases where no legitimate agent
// workflow needs the command, and the blast radius is severe.
//
// Style guidelines for additions:
//   - Be SPECIFIC. Match the dangerous form, not all uses of the binary.
//     Block `rm -rf /` not `rm`. Block `dd of=/dev/sd*` not `dd`.
//   - Anchor patterns. Use word boundaries / start-of-token where possible
//     so `git arm-rf-feature` doesn't accidentally match `rm -rf`.
//   - Prefer functions over regex when intent is non-trivial — easier to
//     read and debug than a 200-char regex.
const FORBIDDEN: readonly ForbiddenPattern[] = [
  {
    id: 'rm-rf-root',
    // rm with -r/-R/--recursive AND -f/--force, targeting / or /* or
    // common dangerous absolute roots. Tolerates flag ordering and
    // long-form variants.
    test: cmd => {
      if (!/\brm\b/.test(cmd)) return false;
      const hasRecursive = /(-[a-zA-Z]*r[a-zA-Z]*|--recursive)/.test(cmd);
      const hasForce = /(-[a-zA-Z]*f[a-zA-Z]*|--force)/.test(cmd);
      if (!(hasRecursive && hasForce)) return false;
      // Target: bare / or /* or /<single-char>* near the rm.
      return /\brm\b[^|;&]*\s(\/|\/\*|\/\.\*|"\/"|'\/'|\$HOME|~)(\s|$|\*)/.test(cmd);
    },
    reason: 'recursive force-delete targeting filesystem root or $HOME — almost always a mistake',
  },
  {
    id: 'fork-bomb',
    test: cmd => /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(cmd),
    reason: 'fork bomb',
  },
  {
    id: 'curl-pipe-shell',
    // curl/wget/fetch piped into sh/bash/zsh — the canonical
    // remote-code-execution pattern. We block both the `| sh` and
    // `$(curl ...)` execution forms.
    test: cmd => {
      const fetcher = /\b(curl|wget|fetch)\b[^|;&`]*/;
      const intoShell = /\|\s*(sh|bash|zsh|ksh|fish|dash)\b/;
      if (fetcher.test(cmd) && intoShell.test(cmd)) return true;
      // $(curl ...) or `curl ...` consumed as a command
      if (/\$\(\s*(curl|wget|fetch)\b/.test(cmd)) return true;
      if (/`\s*(curl|wget|fetch)\b/.test(cmd)) return true;
      return false;
    },
    reason: 'remote script piped into a shell — classic supply-chain RCE pattern',
  },
  {
    id: 'dd-to-device',
    test: cmd => /\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|hd|vd|disk|rdisk)/.test(cmd),
    reason: 'raw write to a block device (data destruction)',
  },
  {
    id: 'mkfs',
    test: cmd => /\bmkfs(\.[a-z0-9]+)?\b\s+\/dev\//.test(cmd),
    reason: 'reformatting a filesystem',
  },
  {
    id: 'chmod-777-root',
    test: cmd => /\bchmod\b[^|;&]*\s(-R\s+)?7{3,4}\s+(\/|\/\*|~|\$HOME)(\s|$)/.test(cmd),
    reason: 'world-writable on filesystem root or $HOME',
  },
  {
    id: 'redirect-to-device',
    test: cmd => />\s*\/dev\/(sd|nvme|hd|vd|disk|rdisk)[a-z0-9]/.test(cmd),
    reason: 'shell redirect into a raw block device',
  },
  {
    id: 'force-push-protected',
    // git push --force / -f targeting main/master/release branches.
    // Common when an agent "fixes" a botched merge.
    test: cmd => {
      if (!/\bgit\s+push\b/.test(cmd)) return false;
      const forced = /(--force(?!-with-lease)|--force-with-lease=[^ ]*|(?<![\w-])-f(?![\w-]))/.test(
        cmd,
      );
      if (!forced) return false;
      return /\b(main|master|release|prod|production)\b/.test(cmd);
    },
    reason: 'force-push to a protected branch (main/master/release/prod)',
  },
];

export function matchUserRule(
  cmd: string,
  rules: BashRule[],
): { rule: BashRule; index: number } | null {
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!;
    if (globToRegex(r.pattern).test(cmd)) {
      return { rule: r, index: i };
    }
  }
  return null;
}

export function checkForbidden(cmd: string): { id: string; reason: string } | null {
  for (const f of FORBIDDEN) {
    if (f.test(cmd)) return { id: f.id, reason: f.reason };
  }
  return null;
}

/**
 * Evaluate a Bash command against forbidden patterns + user rules.
 * Does NOT consider PermissionManager allow-all; that's the caller's job
 * (so the caller can apply allow-all only to the 'prompt' default case).
 */
export function evaluateBash(cmd: string, userRules: BashRule[] = []): BashEvaluation {
  const forbidden = checkForbidden(cmd);
  if (forbidden) {
    return {
      decision: 'deny',
      reason:
        `Bash command blocked by built-in safety policy: ${forbidden.reason}. ` +
        `This rule cannot be overridden — modify the request or run the command outside the agent.`,
      source: `forbidden:${forbidden.id}`,
    };
  }
  const userMatch = matchUserRule(cmd, userRules);
  if (userMatch) {
    const { rule, index } = userMatch;
    if (rule.decision === 'deny') {
      return {
        decision: 'deny',
        reason:
          `Bash command blocked by user rule "${rule.pattern}"` +
          (rule.note ? ` (${rule.note})` : '') +
          '.',
        source: `user:${index}`,
      };
    }
    return { decision: rule.decision, source: `user:${index}` };
  }
  return { decision: 'prompt', source: 'default' };
}

// Exported for tests
export const __testing = { FORBIDDEN, globToRegex };
