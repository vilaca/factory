import { describe, it } from 'node:test';
import assert from 'node:assert';
import { classifyForRotation } from '../../../../../src/core/agent/call-model/provider-errors.js';

describe('classifyForRotation', () => {
  describe('via .status / .statusCode field', () => {
    it('returns rate-limit for 429', () => {
      assert.strictEqual(classifyForRotation({ status: 429, message: '' }), 'rate-limit');
      assert.strictEqual(classifyForRotation({ statusCode: 429 }), 'rate-limit');
    });

    it('returns auth for 401 / 403', () => {
      assert.strictEqual(classifyForRotation({ status: 401 }), 'auth');
      assert.strictEqual(classifyForRotation({ status: 403 }), 'auth');
      assert.strictEqual(classifyForRotation({ statusCode: 401 }), 'auth');
    });

    it('returns other for 5xx and 4xx outside the rotatable set', () => {
      assert.strictEqual(classifyForRotation({ status: 500 }), 'other');
      assert.strictEqual(classifyForRotation({ status: 502 }), 'other');
      assert.strictEqual(classifyForRotation({ status: 400 }), 'other');
      assert.strictEqual(classifyForRotation({ status: 404 }), 'other');
    });
  });

  describe('via message text', () => {
    it('detects rate-limit phrases', () => {
      assert.strictEqual(classifyForRotation(new Error('429 Too Many Requests')), 'rate-limit');
      assert.strictEqual(classifyForRotation(new Error('rate limit exceeded')), 'rate-limit');
      assert.strictEqual(classifyForRotation(new Error('rate-limit hit')), 'rate-limit');
      assert.strictEqual(classifyForRotation(new Error('throttled')), 'rate-limit');
      assert.strictEqual(classifyForRotation(new Error('insufficient_quota')), 'rate-limit');
      assert.strictEqual(classifyForRotation(new Error('quota exceeded')), 'rate-limit');
    });

    it('detects auth phrases', () => {
      assert.strictEqual(classifyForRotation(new Error('401 Unauthorized')), 'auth');
      assert.strictEqual(classifyForRotation(new Error('403 Forbidden')), 'auth');
      assert.strictEqual(classifyForRotation(new Error('Invalid API key')), 'auth');
      assert.strictEqual(classifyForRotation(new Error('invalid_api_key')), 'auth');
      assert.strictEqual(classifyForRotation(new Error('authentication-error')), 'auth');
      assert.strictEqual(classifyForRotation(new Error('api key expired')), 'auth');
    });

    it('returns other for transport / shape errors', () => {
      assert.strictEqual(classifyForRotation(new Error('socket hang up')), 'other');
      assert.strictEqual(classifyForRotation(new Error('connection dropped')), 'other');
      assert.strictEqual(classifyForRotation(new Error('fetch failed')), 'other');
      assert.strictEqual(classifyForRotation(new Error('Request body shape invalid')), 'other');
    });
  });

  it('handles undefined / non-Error inputs', () => {
    assert.strictEqual(classifyForRotation(undefined), 'other');
    assert.strictEqual(classifyForRotation(null), 'other');
    assert.strictEqual(classifyForRotation('429'), 'rate-limit');
    assert.strictEqual(classifyForRotation('forbidden'), 'auth');
  });

  it('prefers status code over message when both disagree', () => {
    // A 500 with "rate limit" in the body still classifies as rate-limit
    // because the regex catches it — but a clean 429 status overrides
    // text-only signal in the same direction. The intent of this test is
    // to lock the precedence: status first.
    assert.strictEqual(classifyForRotation({ status: 429, message: 'oops' }), 'rate-limit');
    assert.strictEqual(classifyForRotation({ status: 401, message: 'rate limit' }), 'auth');
  });
});
