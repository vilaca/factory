import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSamplingDefaults,
  applySamplingDefaults,
  UnsupportedModelError,
  _resetSamplingLogForTests,
} from '../../../src/providers/sampling-defaults.js';

describe('getSamplingDefaults', () => {
  it('returns {} for unknown model', () => {
    assert.deepEqual(getSamplingDefaults('totally-fake-model'), {});
  });

  it('returns Ministral Reasoning defaults', () => {
    const d = getSamplingDefaults('ministral-3-8b-reasoning-Q4_K_M');
    assert.equal(d.temperature, 0.6);
    assert.equal(d.topP, 0.95);
  });

  it('returns Ministral Instruct defaults', () => {
    const d = getSamplingDefaults('ministral-3-8b-instruct-Q4_K_M');
    assert.equal(d.temperature, 0.05);
  });

  it('longest matching key wins (Reasoning over Ministral generic)', () => {
    // "ministral-3-reasoning" is longer/more specific than "ministral-3"
    const d = getSamplingDefaults('Ministral-3-Reasoning-Q8');
    assert.equal(d.temperature, 0.6);
  });

  it('case-insensitive matching', () => {
    const d = getSamplingDefaults('QWEN3-thinking-14B');
    assert.equal(d.temperature, 0.6);
    assert.equal(d.topK, 20);
  });

  it('Granite 4.0 → greedy decoding', () => {
    assert.equal(getSamplingDefaults('granite-4.0-8b-instruct').temperature, 0.0);
  });
});

describe('applySamplingDefaults — strict policy', () => {
  it('strict + hit → returns defaults', () => {
    _resetSamplingLogForTests();
    const d = applySamplingDefaults('ministral-3-reasoning-q4', { strict: true });
    assert.equal(d.temperature, 0.6);
  });

  it('strict + miss → throws UnsupportedModelError', () => {
    _resetSamplingLogForTests();
    assert.throws(
      () => applySamplingDefaults('not-a-known-model', { strict: true }),
      UnsupportedModelError,
    );
  });

  it('non-strict + hit → returns defaults (and logs once)', () => {
    _resetSamplingLogForTests();
    const d1 = applySamplingDefaults('qwen3-8b', { strict: false, providerName: 'ollama' });
    const d2 = applySamplingDefaults('qwen3-8b', { strict: false, providerName: 'ollama' });
    assert.equal(d1.temperature, 0.7);
    assert.deepEqual(d1, d2);
  });

  it('non-strict + miss → empty object (silent fallthrough)', () => {
    _resetSamplingLogForTests();
    assert.deepEqual(applySamplingDefaults('weird-unknown', { strict: false }), {});
  });
});
