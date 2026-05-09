import type { AgentEvent } from '../types.js';
import { classifyForRetry, nextDelayMs } from './provider-retry.js';
import type { resolveRetryPolicy } from './provider-retry.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    // Don't keep the event loop alive just for the backoff — if the host
    // is shutting down, the timer should not block exit.
    t.unref?.();
  });
}

export interface RetryOutcome {
  /** True when a retry was attempted; the caller should `continue` the loop. */
  retried: boolean;
  /** Updated attempt counter to write back into the caller. */
  nextAttempt: number;
}

/**
 * Decide whether to attempt a same-key retry for `err`, yield the
 * `provider-retry` event if so, and sleep the backoff. Extracted to keep
 * the main `callModel` body under the cognitive-complexity cap.
 *
 * Rate-limits (429) defer to rotation when rotation is configured because
 * a different saved key on the same provider almost always has its own
 * quota window — that gets through faster than waiting out backoff. With
 * no rotation configured, we retry 429 too because retry is the only
 * option left.
 */
export async function* tryRetry(
  err: unknown,
  attempt: number,
  policy: ReturnType<typeof resolveRetryPolicy>,
  hasRotation: boolean,
  alreadyStreamed: boolean,
): AsyncGenerator<AgentEvent, RetryOutcome> {
  if (alreadyStreamed || attempt + 1 >= policy.maxAttempts) {
    return { retried: false, nextAttempt: attempt };
  }
  const decision = classifyForRetry(err);
  const deferToRotation = decision.reason === 'rate-limit' && hasRotation;
  if (!decision.retry || deferToRotation) {
    return { retried: false, nextAttempt: attempt };
  }
  const delayMs = nextDelayMs(attempt, policy);
  const nextAttempt = attempt + 1;
  yield {
    type: 'provider-retry',
    attempt: nextAttempt,
    maxAttempts: policy.maxAttempts,
    delayMs,
    reason: decision.reason ?? 'server-error',
  };
  await sleep(delayMs);
  return { retried: true, nextAttempt };
}
