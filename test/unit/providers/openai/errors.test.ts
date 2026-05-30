import { describe, it } from 'node:test';
import assert from 'node:assert';
import { apiError } from '../../../../src/providers/openai/errors.js';

describe('openai apiError', () => {
  it('captures Retry-After in seconds as retryAfterMs', () => {
    const headers = new Headers({ 'retry-after': '2' });
    const err = apiError('OpenAI', 429, 'rate limit', headers);
    assert.strictEqual(err.retryAfterMs, 2000);
  });

  it('prefers retry-after-ms when present', () => {
    const headers = new Headers({ 'retry-after': '5', 'retry-after-ms': '750' });
    const err = apiError('OpenAI', 429, 'rate limit', headers);
    assert.strictEqual(err.retryAfterMs, 750);
  });
});
