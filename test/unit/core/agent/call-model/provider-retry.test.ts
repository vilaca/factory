import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  classifyForRetry,
  nextDelayMs,
  resolveRetryPolicy,
} from '../../../../../src/core/agent/call-model/provider-retry.js';

describe('classifyForRetry', () => {
  it('classifies 408 / 429 / 5xx as transient', () => {
    assert.deepStrictEqual(classifyForRetry({ status: 408 }), { retry: true, reason: 'timeout' });
    assert.deepStrictEqual(classifyForRetry({ status: 429 }), { retry: true, reason: 'rate-limit' });
    assert.deepStrictEqual(classifyForRetry({ status: 500 }), { retry: true, reason: 'server-error' });
    assert.deepStrictEqual(classifyForRetry({ status: 502 }), { retry: true, reason: 'server-error' });
    assert.deepStrictEqual(classifyForRetry({ status: 503 }), { retry: true, reason: 'server-error' });
    assert.deepStrictEqual(classifyForRetry({ status: 504 }), { retry: true, reason: 'server-error' });
  });

  it('rejects 4xx auth errors and shape errors as non-retryable', () => {
    // Auth → rotation handles it; 4xx other than 408/429 is a bug, not a flake.
    assert.strictEqual(classifyForRetry({ status: 401 }).retry, false);
    assert.strictEqual(classifyForRetry({ status: 403 }).retry, false);
    assert.strictEqual(classifyForRetry({ status: 400 }).retry, false);
    assert.strictEqual(classifyForRetry({ status: 404 }).retry, false);
    assert.strictEqual(classifyForRetry({ status: 422 }).retry, false);
  });

  it('treats 501 / 505 as non-retryable (the call shape is wrong, not the server)', () => {
    assert.strictEqual(classifyForRetry({ status: 501 }).retry, false);
    assert.strictEqual(classifyForRetry({ status: 505 }).retry, false);
  });

  it('matches connection-establishment errors by message text when no status is present', () => {
    // Only the *establishment* errors are classified as transient here.
    // Mid-stream errors (socket hang up, fetch failed, connection dropped)
    // are handled by the call-model isStreamish path, not retry —
    // see provider-retry.ts NETWORK_RE comment.
    for (const msg of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN getaddrinfo']) {
      const decision = classifyForRetry(new Error(msg));
      assert.strictEqual(decision.retry, true, `expected retry for: ${msg}`);
      assert.strictEqual(decision.reason, 'network');
    }
  });

  it('does NOT retry mid-stream errors (those go through isStreamish in call-model)', () => {
    for (const msg of ['socket hang up', 'fetch failed', 'connection dropped']) {
      assert.strictEqual(
        classifyForRetry(new Error(msg)).retry,
        false,
        `should not retry: ${msg}`,
      );
    }
  });

  it('does not retry on plain "other" errors', () => {
    assert.strictEqual(classifyForRetry(new Error('model returned malformed json')).retry, false);
    assert.strictEqual(classifyForRetry({}).retry, false);
    assert.strictEqual(classifyForRetry(null).retry, false);
    assert.strictEqual(classifyForRetry(undefined).retry, false);
  });

  it('also reads statusCode (some SDKs use that name)', () => {
    assert.strictEqual(classifyForRetry({ statusCode: 503 }).retry, true);
  });
});

describe('nextDelayMs', () => {
  it('grows the jitter window exponentially and caps at maxDelayMs', () => {
    // Use random=()=>0.999 so the sample is near the upper edge of the
    // window — that lets us read off the window size from the result.
    const upper = (a: number, p = {}): number => nextDelayMs(a, p, () => 0.999);
    const policy = { baseDelayMs: 100, maxDelayMs: 4000 };
    // Window: min(100 * 2^a, 4000). attempt 0=100, 1=200, 2=400, 3=800, 4=1600, 5=3200, 6=4000(cap).
    assert.ok(upper(0, policy) <= 100);
    assert.ok(upper(1, policy) > 100 && upper(1, policy) <= 200);
    assert.ok(upper(2, policy) > 200 && upper(2, policy) <= 400);
    assert.ok(upper(5, policy) > 1600 && upper(5, policy) <= 3200);
    assert.ok(upper(6, policy) > 3000 && upper(6, policy) <= 4000);
    // Past the cap, the window is the cap regardless of attempt.
    assert.ok(upper(20, policy) > 3000 && upper(20, policy) <= 4000);
  });

  it('always returns 0 when the rng yields 0 (lower bound of the window)', () => {
    const zero = nextDelayMs(5, { baseDelayMs: 100, maxDelayMs: 4000 }, () => 0);
    assert.strictEqual(zero, 0);
  });
});

describe('resolveRetryPolicy', () => {
  it('fills in defaults for unspecified fields', () => {
    assert.deepStrictEqual(resolveRetryPolicy(), {
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 4000,
    });
    assert.deepStrictEqual(resolveRetryPolicy({ maxAttempts: 5 }), {
      maxAttempts: 5,
      baseDelayMs: 250,
      maxDelayMs: 4000,
    });
  });
});
