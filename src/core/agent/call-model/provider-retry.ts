/**
 * Provider call retry policy.
 *
 * Sits in front of rotation: a transient failure (network drop, 5xx, 408,
 * 429 with Retry-After) should be re-attempted on the same key before
 * burning a rotation slot. Without this, a single 503 from an otherwise
 * healthy key forces a key/model swap, which costs the warm cache and
 * spreads load across keys for no reason.
 *
 * Algorithm: full-jitter exponential backoff. Each delay is sampled
 * uniformly from `[0, base * 2^attempt]`, capped at `maxDelayMs`. Full
 * jitter (vs `base * 2^attempt + rand`) is what AWS recommends for
 * thundering-herd avoidance — the variance is the point. Caller controls
 * the budget via `maxAttempts`; default 3 covers the common transient blip
 * without holding a turn hostage on a real outage.
 */

export interface RetryPolicy {
  /** Total attempts including the first call. Default 3. */
  maxAttempts?: number;
  /** Base delay in ms used to seed the jitter window. Default 250. */
  baseDelayMs?: number;
  /** Cap on the jittered delay. Default 4000. Past this point waiting
   *  longer is rarely useful — at that scale a rotation swap will pay off
   *  more than another retry. */
  maxDelayMs?: number;
}

const DEFAULTS: Required<RetryPolicy> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4000,
};

/** Shape returned by `shouldRetry` for the call site to act on. */
export interface RetryDecision {
  retry: boolean;
  /** When `retry` is true, the human-readable reason classified from the
   *  error. Used for telemetry and the status-bar activity label. */
  reason?: 'network' | 'server-error' | 'rate-limit' | 'timeout';
}

// Match connection-establishment errors only. Mid-stream errors like
// 'socket hang up', 'connection dropped', and 'fetch failed' are handled
// by call-model.ts's isStreamish() path (chatNoStream replay), which
// preserves any partial output. Putting them here too would shadow that
// path: retry would fire before isStreamish, replay the streaming call
// from scratch, and lose the partial. Keep the buckets disjoint.
const NETWORK_RE = /(ECONNRESET|ECONNREFUSED|ENETUNREACH|ETIMEDOUT|EAI_AGAIN)/i;

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; statusCode?: unknown };
    if (typeof e.status === 'number') return e.status;
    if (typeof e.statusCode === 'number') return e.statusCode;
  }
  return undefined;
}

function messageOf(err: unknown): string {
  if (
    err &&
    typeof err === 'object' &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  return String(err ?? '');
}

/**
 * Decide whether an error warrants a same-key retry. Transient categories
 * are: connection-level errors, server-side 5xx (excluding 501/505 which
 * indicate a bad request to the wrong API), 408 request-timeout, and 429
 * rate-limit (the retry budget gives the limiter a chance to clear before
 * we spend a rotation slot).
 *
 * 401/403 (auth) and 4xx other than 408/429 are NOT retryable here — they
 * either mean the key is bad (auth → rotate) or the request itself is
 * malformed (other 4xx → bug). 501 ("Not Implemented") and 505 ("Version
 * Not Supported") are 5xx but signal the call shape is wrong, not that
 * the server is having a bad day.
 *
 * Aligned with OpenAI's API error guide
 * (https://developers.openai.com/api/docs/guides/error-codes.md):
 *   - 408 APITimeoutError, 429 RateLimitError, 500 InternalServerError,
 *     503 "engine overloaded" → retry with backoff
 *   - 401 AuthenticationError, 403 PermissionDeniedError, 400 BadRequestError
 *     → do not same-key retry (rotate or surface)
 *
 * Providers must attach `.status` to thrown errors at their boundary (see
 * `providers/openai/errors.ts::apiError`); otherwise this classifier falls
 * through to the network-regex bucket and treats real 5xx as non-retryable.
 *
 * TODO: distinguish OpenAI's 503 "Slow Down" body from the 503 "engine
 * overloaded" body — the former is a hard rate-limit signal that the docs
 * say to back off from for 15 minutes, not to immediately retry. Today both
 * land in the 5xx-retry bucket. Cheap fix is a regex on the body in
 * `apiError` returning status=429 for the Slow Down variant.
 */
// TODO(retry/retry-after): honor the `Retry-After` header on 429/503
// responses. Today we apply jittered exponential backoff and ignore what
// the server tells us to wait — OpenAI's error-codes guide says to honor
// it. Requires the provider boundary (apiError in providers/openai/errors.ts)
// to attach the header value to the thrown error, and nextDelayMs to take
// an optional `minDelayMs` floor that clamps the jitter window upward.
export function classifyForRetry(err: unknown): RetryDecision {
  const status = statusOf(err);
  if (status !== undefined) {
    if (status === 408) return { retry: true, reason: 'timeout' };
    if (status === 429) return { retry: true, reason: 'rate-limit' };
    if (status >= 500 && status < 600 && status !== 501 && status !== 505) {
      return { retry: true, reason: 'server-error' };
    }
    return { retry: false };
  }
  const msg = messageOf(err);
  if (NETWORK_RE.test(msg)) return { retry: true, reason: 'network' };
  return { retry: false };
}

/**
 * Sample the next delay. Pure function — caller can substitute its own
 * RNG (and tests do, for deterministic timing). Default `random` is
 * `Math.random`, which is fine for jitter purposes.
 */
export function nextDelayMs(
  attempt: number,
  policy: RetryPolicy = {},
  random: () => number = Math.random,
): number {
  const { baseDelayMs, maxDelayMs } = { ...DEFAULTS, ...policy };
  // 2^attempt grows fast; clamp BEFORE jittering so the random window
  // never exceeds the cap. Otherwise a `cap=4000, base=250, attempt=10`
  // call would have a window of 256000ms with a hard ceiling at 4000 —
  // most rolls would land at the cap, defeating the jitter.
  const window = Math.min(baseDelayMs * 2 ** Math.max(0, attempt), maxDelayMs);
  return Math.floor(window * random());
}

/** Effective policy with defaults applied. Useful for tests/UI labels. */
export function resolveRetryPolicy(policy: RetryPolicy = {}): Required<RetryPolicy> {
  return { ...DEFAULTS, ...policy };
}
