// Path policy for Read/Write/Edit.
//
// Threat: file-access tools can read or clobber any path the user can,
// including credential stores (~/.ssh, ~/.aws, ~/.factory) and system
// files (/etc/shadow, /etc/sudoers). A prompt-injected model that gets
// the user to approve "Read(file_path=…)" once exfiltrates whatever
// path it points at.
//
// Policy: hard deny on a built-in set of secret paths. Denial happens
// inside the tool's execute() before any I/O, so the model sees a clean
// error and the user never sees a permission prompt that, if approved,
// would leak the file. Built-ins cannot be overridden — if you really
// need to read ~/.ssh/known_hosts, do it outside the agent. Users can
// extend the deny list via config but cannot shorten it.
//
// Symlink handling: we resolve realpath() before checking, so an attacker
// cannot bypass via `ln -s ~/.ssh/id_rsa /tmp/safe-looking-name`. If
// realpath fails (file doesn't exist yet, e.g. Write to a new file), we
// fall back to a lexical resolve of the parent directory and re-check.

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export interface PathPolicy {
  /** Additional roots/files to deny (beyond the built-ins). */
  deny?: string[];
}

export class PathDenied extends Error {
  constructor(public readonly attemptedPath: string, public readonly matchedRule: string) {
    super(
      `Path denied by security policy: ${attemptedPath} ` +
      `(matches "${matchedRule}"). This path holds credentials or system ` +
      `state and is hard-denied by the agent. Read or modify it outside ` +
      `the agent if you genuinely need to.`,
    );
    this.name = 'PathDenied';
  }
}

// Built-in deny list. Each entry is either a directory (no trailing slash)
// — meaning "this dir and everything under it" — or a specific file.
// Tilde is expanded once at load time, NOT per-check.
async function realpathOrLexical(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

function builtinDenyPaths(): string[] {
  const home = os.homedir();
  return [
    // Per-user secret stores
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws'),
    path.join(home, '.azure'),
    path.join(home, '.config', 'gh'),         // GitHub CLI token
    path.join(home, '.config', 'gcloud'),     // gcloud creds
    path.join(home, '.config', 'factory'),    // our own config
    path.join(home, '.factory'),              // legacy/sessions dir
    path.join(home, '.netrc'),
    path.join(home, '.pgpass'),
    path.join(home, '.npmrc'),                // often holds NPM_TOKEN
    path.join(home, '.pypirc'),               // PyPI token
    path.join(home, '.cargo', 'credentials'),
    path.join(home, '.cargo', 'credentials.toml'),
    path.join(home, '.kube'),                 // kubeconfig + tokens
    path.join(home, '.docker', 'config.json'),
    path.join(home, 'Library', 'Application Support', 'gh'),  // macOS gh

    // System secret/auth files. List both lexical and macOS-canonical
    // forms because /etc and /var are symlinks into /private on macOS;
    // checking only one side leaves a bypass.
    '/etc/shadow',
    '/etc/sudoers',
    '/etc/sudoers.d',
    '/etc/master.passwd',           // BSD/macOS
    '/private/etc/shadow',
    '/private/etc/sudoers',
    '/private/etc/sudoers.d',
    '/private/etc/master.passwd',
  ];
}

export interface PathCheckResult {
  ok: boolean;
  /** When ok=false, the rule that matched (built-in or user). */
  matchedRule?: string;
  /** The path used for the check (after realpath when possible). */
  resolved: string;
}

/**
 * Resolve a candidate path through realpath() to defeat symlink games,
 * falling back to a lexical resolve when the file doesn't exist (e.g. a
 * Write to a new path). For non-existent files we resolve the deepest
 * existing ancestor instead, so a write to `~/.ssh/new-key-i-just-created`
 * still gets caught.
 */
async function resolveForCheck(input: string): Promise<string> {
  const lexical = path.resolve(input);
  try {
    return await fs.realpath(lexical);
  } catch {
    // Walk up to the nearest existing ancestor and realpath that, then
    // re-attach the missing tail. This ensures `~/.ssh/<not-yet-created>`
    // resolves under the real ~/.ssh dir even when the file is absent.
    let dir = path.dirname(lexical);
    let tail = path.basename(lexical);
    while (dir !== path.dirname(dir)) {
      try {
        const realDir = await fs.realpath(dir);
        return path.join(realDir, tail);
      } catch {
        tail = path.join(path.basename(dir), tail);
        dir = path.dirname(dir);
      }
    }
    return lexical;
  }
}

function matchDeny(candidate: string, deniedRoots: string[]): string | null {
  for (const root of deniedRoots) {
    if (candidate === root) return root;
    if (candidate.startsWith(root + path.sep)) return root;
  }
  return null;
}

/**
 * Check whether a path is allowed. User policy entries are additive — they
 * extend the built-in deny list but cannot remove from it.
 *
 * The check runs against BOTH the lexical resolve and the realpath form,
 * because:
 *   - macOS routes `/etc` and `/var` through `/private/...` symlinks.
 *     A user typing `/etc/shadow` lexically resolves to `/etc/shadow`
 *     but realpath gives `/private/etc/shadow`. We list both forms in
 *     the built-in deny set, but checking both lexical+realpath also
 *     defends against attackers who construct one form to slip past the
 *     other.
 *   - User-supplied deny entries are also passed through realpath so
 *     `/tmp/sensitive` (which is a symlink on macOS) and its real path
 *     `/private/tmp/sensitive` both match.
 */
export async function checkPath(
  input: string,
  policy: PathPolicy = {},
): Promise<PathCheckResult> {
  const lexical = path.resolve(input);
  const resolved = await resolveForCheck(input);

  const userDenyExpanded = (policy.deny ?? []).map(p =>
    path.resolve(p.replace(/^~(?=$|\/)/, os.homedir())),
  );
  const userDenyRealpathed = await Promise.all(userDenyExpanded.map(realpathOrLexical));
  const denied = [
    ...builtinDenyPaths(),
    ...userDenyExpanded,
    ...userDenyRealpathed,
  ];

  const matchedRule = matchDeny(lexical, denied) ?? matchDeny(resolved, denied);
  if (matchedRule) {
    return { ok: false, matchedRule, resolved };
  }
  return { ok: true, resolved };
}

/**
 * Throw PathDenied if the path is on the deny list. Used by tools that
 * want to surface a clean ToolResult; callers catch and convert to
 * `{success: false, output: err.message}`.
 */
export async function assertPathAllowed(input: string, policy?: PathPolicy): Promise<string> {
  const result = await checkPath(input, policy);
  if (!result.ok) {
    throw new PathDenied(input, result.matchedRule!);
  }
  return result.resolved;
}

/**
 * Build a synchronous deny-matcher with realpath applied to the deny set
 * up front. The returned function takes a candidate path and returns the
 * matched rule (or null) without any further I/O — meant for tight loops
 * (post-filtering thousands of search results) where a per-call realpath
 * would be too costly.
 *
 * Both the lexical and realpathed forms of every deny entry are kept, so
 * macOS /tmp ↔ /private/tmp routing is symmetric: a candidate emitted as
 * /private/tmp/forbidden/x matches a user deny of /tmp/forbidden, and
 * vice versa. Symlink defense beyond that relies on:
 *   1. The search root having already passed assertPathAllowed (which
 *      realpaths it), so a symlinked-root attack is caught upstream.
 *   2. The search tool not following symlinks during recursion (default
 *      behavior of ripgrep, grep -r, and Node's fs.glob).
 */
export async function buildDenyMatcher(
  policy: PathPolicy = {},
): Promise<(candidate: string) => string | null> {
  const userDenyExpanded = (policy.deny ?? []).map(p =>
    path.resolve(p.replace(/^~(?=$|\/)/, os.homedir())),
  );
  const userDenyRealpathed = await Promise.all(userDenyExpanded.map(realpathOrLexical));
  const builtin = builtinDenyPaths();
  const builtinRealpathed = await Promise.all(builtin.map(realpathOrLexical));
  const denied = [
    ...builtin,
    ...builtinRealpathed,
    ...userDenyExpanded,
    ...userDenyRealpathed,
  ];
  return (candidate: string) => matchDeny(path.resolve(candidate), denied);
}

// Exported for tests.
export const __testing = { builtinDenyPaths, resolveForCheck };
