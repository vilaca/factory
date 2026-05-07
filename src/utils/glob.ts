/**
 * Translate a shell-style glob into an anchored RegExp using POSIX-glob
 * semantics: `*` and `?` do NOT cross path separators; `**` does.
 *
 *   `*`  → any run of non-`/` characters
 *   `**` → any run of characters, including `/`
 *   `?`  → exactly one non-`/` character
 *
 * Every other regex metacharacter is escaped, so a pattern like
 * `git push origin main` matches that literal string.
 *
 * Used in three places: Bash user-rule matching, hook matcher matching, and
 * project-fact marker globs. They all share this single definition so a
 * pattern that works in one site behaves identically in the others.
 */
export function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

/** Convenience: returns true when `value` matches `pattern`. */
export function globMatch(pattern: string, value: string): boolean {
  return globToRegex(pattern).test(value);
}
