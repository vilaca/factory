/**
 * Race `work` against a wall-clock budget. If `work` settles first,
 * its value (or rejection) is forwarded. If the budget elapses first,
 * `onTimeout` runs and the returned promise resolves with `undefined` —
 * the still-running `work` promise is orphaned (caller must accept that
 * it may continue executing in the background).
 *
 * Used by the SIGINT/SIGTERM handler to cap shutdown time: an MCP
 * server that hangs on `close()` should not block process exit forever.
 *
 * Timer is intentionally refed: callers that race against it need the
 * event loop kept alive until either `work` settles or the budget fires.
 * Signals and process.exit() preempt this anyway.
 */
export function withBoundedTimeout<T>(
  work: () => Promise<T>,
  budgetMs: number,
  onTimeout: () => void,
): Promise<T | undefined> {
  return Promise.race([
    work(),
    new Promise<undefined>(resolve => {
      setTimeout(() => {
        onTimeout();
        resolve(undefined);
      }, budgetMs);
    }),
  ]);
}
