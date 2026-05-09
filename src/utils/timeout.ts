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
 * The timer is `unref()`'d so it doesn't keep the event loop alive on
 * its own.
 */
export function withBoundedTimeout<T>(
  work: () => Promise<T>,
  budgetMs: number,
  onTimeout: () => void,
): Promise<T | undefined> {
  return Promise.race([
    work(),
    new Promise<undefined>(resolve => {
      const t = setTimeout(() => {
        onTimeout();
        resolve(undefined);
      }, budgetMs);
      t.unref?.();
    }),
  ]);
}
