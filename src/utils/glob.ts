/**
 * Translate a shell-style glob into an anchored RegExp.
 *
 * Supports `*` (any run of characters) and `?` (one character). Every other
 * regex metacharacter is escaped, so a pattern like `git push origin main`
 * matches that literal string, not "git push origin mai" + any char.
 *
 * Used in three places: Bash user-rule matching, hook matcher matching, and
 * project-fact marker globs. They all share this single definition so a
 * pattern that works in one site behaves identically in the others.
 */
export function globToRegex(glob: string): RegExp {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** Convenience: returns true when `value` matches `pattern`. */
export function globMatch(pattern: string, value: string): boolean {
  return globToRegex(pattern).test(value);
}
