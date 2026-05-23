// Pure formatting helpers shared by the headless and TUI agent-event
// renderers. Both surfaces consume the same AgentEvent stream and need
// rotation/fingerprint/hook labels to stay identical — when a label
// drifts in one place but not the other, debugging the drift is harder
// than debugging the underlying event. Side-effect-free; the caller
// decides what to do with the string (process.stderr.write, addNotice,
// session log, …).
//
// Lives under src/ui/agent-events/ rather than src/ui/tui/ so the
// headless runner can import without violating the
// "headless must not depend on tui" arch rule.

/** "rate-limit" | "auth" → human-readable phrase used in rotation lines. */
export function describeRotationReason(reason: string): string {
  return reason === 'rate-limit' ? 'rate-limited' : 'auth failed';
}

/** Key-rotation display label: `<label> · …<fingerprint>` when the entry
 *  has a label, otherwise just `…<fingerprint>`. */
export function fingerprintLabel(entry: { label?: string; fingerprint: string }): string {
  return entry.label ? `${entry.label} · …${entry.fingerprint}` : `…${entry.fingerprint}`;
}

/** Hook event display parts. Strips the shell command down to the first
 *  token and returns its basename so a long path like
 *  `/usr/local/bin/my-hook --arg foo` renders as `my-hook`. The `notice`
 *  is appended as ` — <notice>` when present. */
export function formatHookDisplay(
  hookCommand: string,
  notice: string | undefined,
): { display: string; suffix: string } {
  const firstToken = hookCommand.split(/\s+/)[0] ?? hookCommand;
  const display = firstToken.split('/').pop() ?? firstToken;
  const suffix = notice ? ` — ${notice}` : '';
  return { display, suffix };
}
