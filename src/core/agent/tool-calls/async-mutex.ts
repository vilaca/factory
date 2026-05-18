/**
 * One-slot async mutex. `acquire()` resolves immediately when the slot is
 * free, otherwise it waits in FIFO order until the current holder calls
 * the returned `release()`.
 *
 * Used by the parallel-Delegate batch path to serialize human-facing
 * permission prompts even though tool execution itself runs in parallel.
 * Without this, a model that emits N un-pre-allowed Delegate calls in one
 * turn would dump N `permission-request` events into the host stream
 * simultaneously, which the Ink renderer is not built to handle.
 *
 * Intentionally tiny — we don't need re-entrancy, fairness beyond FIFO,
 * timeouts, or cancellation. If a holder forgets to release, the lock
 * stays held; that's deliberate (better to deadlock visibly in a test
 * than silently double-prompt).
 */
export class AsyncMutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  /** Resolves with the release function. Always pair with a try/finally
   *  so a thrown error inside the critical section still releases. */
  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    await new Promise<void>(resolve => this.waiters.push(resolve));
    // When we wake up, the previous holder has already cleared `locked` in
    // release() and is about to hand the slot to us — re-take it here so
    // the next acquirer sees `locked=true` again.
    this.locked = true;
    return () => this.release();
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the lock to the next waiter directly. We leave `locked=true`
      // — the waiter's await resolves and its acquire() body re-asserts
      // `locked=true` (a no-op) before returning. This eliminates the
      // brief window in which a fresh acquire() call could steal the
      // slot out from under a queued waiter.
      next();
    } else {
      this.locked = false;
    }
  }
}
