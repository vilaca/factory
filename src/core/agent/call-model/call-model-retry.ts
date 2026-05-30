import type { AgentEvent } from '../types.js';
import { classifyForRetry, nextDelayMs } from './provider-retry.js';
import type { resolveRetryPolicy } from './provider-retry.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
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
 * For rate limits carrying a provider-specified wait (`retryAfterMs` from
 * Retry-After headers), we honor that delay before considering rotation.
 * This matches OpenAI throttling guidance and avoids burning keys when the
 * server has already told us exactly when to retry.
 */
export async function* tryRetry(
  err: unknown,
  attempt: number,
  policy: ReturnType<typeof resolveRetryPolicy>,
  hasRotation: boolean,
  alreadyStreamed: boolean,
): AsyncGenerator<AgentEvent, RetryOutcome> {
  if (alreadyStreamed) {
    return { retried: false, nextAttempt: attempt };
  }

  const decision = classifyForRetry(err);
  if (!decision.retry) {
    return { retried: false, nextAttempt: attempt };
  }

  const hasServerWait = decision.reason === 'rate-limit' && decision.retryAfterMs !== undefined;
  const maxRetries = hasServerWait ? 3 : Math.max(0, policy.maxAttempts - 1);
  if (attempt >= maxRetries) {
    return { retried: false, nextAttempt: attempt };
  }

  const deferToRotation = decision.reason === 'rate-limit' && hasRotation && !hasServerWait;
  if (deferToRotation) {
    return { retried: false, nextAttempt: attempt };
  }

  const delayMs = hasServerWait ? (decision.retryAfterMs ?? 0) : nextDelayMs(attempt, policy);
  const nextAttempt = attempt + 1;
  yield {
    type: 'provider-retry',
    attempt: nextAttempt,
    maxAttempts: hasServerWait ? maxRetries + 1 : policy.maxAttempts,
    delayMs,
    reason: decision.reason ?? 'server-error',
  };
  await sleep(delayMs);
  return { retried: true, nextAttempt };
}
