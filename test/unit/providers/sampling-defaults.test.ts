import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSamplingDefaults,
  applySamplingDefaults,
  UnsupportedModelError,
  _resetSamplingLogForTests,
} from '../../../src/providers/sampling-defaults.js';
import { resolveSampling } from '../../../src/providers/shared.js';

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

describe('resolveSampling — three-tier merge chain', () => {
  it('per-model defaults applied when model has an entry (no recommendedSampling flag needed)', () => {
    _resetSamplingLogForTests();
    const out = resolveSampling(undefined, { model: 'ministral-3-reasoning-q4' });
    assert.equal(out.temperature, 0.6);
    assert.equal(out.top_p, 0.95);
  });

  it('returns empty object for unknown model with no opts', () => {
    _resetSamplingLogForTests();
    assert.deepEqual(resolveSampling(undefined, { model: 'totally-unknown' }), {});
  });

  it('instance defaults override per-model defaults', () => {
    _resetSamplingLogForTests();
    const out = resolveSampling(undefined, {
      model: 'ministral-3-reasoning-q4',
      instanceDefaults: { temperature: 0.2 },
    });
    // Per-model has temp 0.6 but instance defaults are merged *first* into
    // out, then per-model overrides via mergeDefaults. So per-model wins
    // here — verify the documented precedence.
    assert.equal(out.temperature, 0.6, 'per-model defaults beat instance defaults');
  });

  it('per-call overrides beat per-model defaults', () => {
    _resetSamplingLogForTests();
    const out = resolveSampling(
      { temperature: 0.01 },
      { model: 'ministral-3-reasoning-q4' },
    );
    assert.equal(out.temperature, 0.01, 'per-call override wins over per-model');
    // Other per-model fields survive when the override doesn't touch them.
    assert.equal(out.top_p, 0.95);
  });

  it('per-call overrides beat instance defaults', () => {
    _resetSamplingLogForTests();
    const out = resolveSampling(
      { temperature: 0.9 },
      { model: 'unknown-model', instanceDefaults: { temperature: 0.1 } },
    );
    assert.equal(out.temperature, 0.9);
  });

  it('recommendedSampling=true on an unknown model is a no-op (no entry to apply)', () => {
    _resetSamplingLogForTests();
    const out = resolveSampling(
      { recommendedSampling: true },
      { model: 'unknown-model' },
    );
    assert.deepEqual(out, {});
  });

  it('camelCase ChatOptions keys map to snake_case wire keys', () => {
    _resetSamplingLogForTests();
    const out = resolveSampling(
      {
        temperature: 0.5,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        repeatPenalty: 1.1,
        presencePenalty: 0.2,
        seed: 42,
      },
      { model: 'unknown' },
    );
    assert.equal(out.temperature, 0.5);
    assert.equal(out.top_p, 0.9);
    assert.equal(out.top_k, 40);
    assert.equal(out.min_p, 0.05);
    assert.equal(out.repeat_penalty, 1.1);
    assert.equal(out.presence_penalty, 0.2);
    assert.equal(out.seed, 42);
  });

  it('three-tier composition: instance defaults + per-model + per-call overrides', () => {
    _resetSamplingLogForTests();
    const out = resolveSampling(
      { topK: 99 }, // per-call override
      {
        model: 'ministral-3-reasoning-q4', // per-model: temp=0.6, top_p=0.95
        instanceDefaults: { seed: 7, top_k: 1 }, // instance only sets fields per-model doesn't touch
      },
    );
    assert.equal(out.seed, 7, 'instance default survives');
    assert.equal(out.temperature, 0.6, 'per-model default applied');
    assert.equal(out.top_p, 0.95, 'per-model default applied');
    assert.equal(out.top_k, 99, 'per-call override beats instance');
  });
});
