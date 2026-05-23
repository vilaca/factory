import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSamplingDefaults,
  applySamplingDefaults,
  UnsupportedModelError,
  _resetSamplingLogForTests,
} from '../../../src/providers/sampling-defaults.js';
import {
  resolveSampling,
  applySamplingToBody,
  resolveThinking,
  autoDetectThinking,
  ThinkingNotSupportedError,
} from '../../../src/providers/shared.js';

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

  it('does not mutate instanceDefaults across calls', () => {
    _resetSamplingLogForTests();
    const instanceDefaults = { temperature: 0.1, top_k: 50 } as const;
    const snapshot = structuredClone(instanceDefaults);
    // Repeatedly resolve against per-model + per-call overrides — none of
    // these paths should write back to the caller's object.
    resolveSampling({ temperature: 0.9 }, {
      model: 'ministral-3-reasoning-q4',
      instanceDefaults: { ...instanceDefaults },
    });
    resolveSampling({ topK: 99, seed: 42 }, {
      model: 'unknown-model',
      instanceDefaults: { ...instanceDefaults },
    });
    assert.deepEqual(instanceDefaults, snapshot, 'instanceDefaults must survive untouched');
  });

  it('applySamplingToBody does not mutate the resolved sampling object', () => {
    _resetSamplingLogForTests();
    const sampling = resolveSampling(
      { temperature: 0.3, topP: 0.8, seed: 5 },
      { model: 'unknown' },
    );
    const samplingSnapshot = structuredClone(sampling);
    const body = { model: 'x', messages: [] } as Record<string, unknown>;
    applySamplingToBody(body, sampling);
    assert.deepEqual(sampling, samplingSnapshot, 'resolved sampling must not be mutated');
    assert.equal(body.temperature, 0.3);
    assert.equal(body.seed, 5);
  });

  it('three-tier composition: instance defaults + per-model + per-call overrides', () => {
    _resetSamplingLogForTests();
    const out = resolveSampling(
      { topK: 99, seed: 7 }, // per-call overrides (seed is per-call only)
      {
        model: 'ministral-3-reasoning-q4', // per-model: temp=0.6, top_p=0.95
        instanceDefaults: { top_k: 1 }, // instance only sets fields per-model doesn't touch
      },
    );
    assert.equal(out.seed, 7, 'per-call seed survives');
    assert.equal(out.temperature, 0.6, 'per-model default applied');
    assert.equal(out.top_p, 0.95, 'per-model default applied');
    assert.equal(out.top_k, 99, 'per-call override beats instance');
  });

  it('rejects instance-level seed (per-call only, per spec §17)', () => {
    _resetSamplingLogForTests();
    assert.throws(
      () =>
        resolveSampling(undefined, {
          model: 'unknown',
          instanceDefaults: { seed: 7 },
        }),
      /seed is per-call only/,
    );
  });
});

describe('autoDetectThinking', () => {
  it('returns true for names containing "reason"', () => {
    assert.equal(autoDetectThinking('ministral-3-8b-reasoning-Q4_K_M'), true);
  });

  it('returns true for names containing "think"', () => {
    assert.equal(autoDetectThinking('qwen3-thinking-14b'), true);
  });

  it('is case-insensitive', () => {
    assert.equal(autoDetectThinking('MyModel-REASON-final'), true);
  });

  it('returns false for plain instruct/chat names', () => {
    assert.equal(autoDetectThinking('llama-3.1-8b-instruct'), false);
    assert.equal(autoDetectThinking('mistral-7b-instruct'), false);
  });
});

describe('resolveThinking (tri-state)', () => {
  it('returns true verbatim when caller explicitly sets true', () => {
    assert.equal(resolveThinking('llama-3.1-8b-instruct', true), true);
  });

  it('returns false verbatim when caller explicitly sets false', () => {
    // Even on a reasoning model — explicit false must beat the heuristic.
    assert.equal(resolveThinking('ministral-3-reasoning-q4', false), false);
  });

  it("falls back to auto-detect for 'auto'", () => {
    assert.equal(resolveThinking('ministral-3-reasoning-q4', 'auto'), true);
    assert.equal(resolveThinking('llama-3.1-8b-instruct', 'auto'), false);
  });

  it('treats undefined the same as auto', () => {
    assert.equal(resolveThinking('qwen3-thinking-14b', undefined), true);
    assert.equal(resolveThinking('llama-3.1-8b', undefined), false);
  });
});

describe('ThinkingNotSupportedError', () => {
  it('captures the model and is an Error subclass', () => {
    const err = new ThinkingNotSupportedError('mystery-model');
    assert.equal(err.name, 'ThinkingNotSupportedError');
    assert.equal(err.model, 'mystery-model');
    assert.ok(err instanceof Error);
    assert.match(err.message, /mystery-model/);
  });

  it('includes the backend cause in the message when provided', () => {
    const err = new ThinkingNotSupportedError('m', 'no such field');
    assert.match(err.message, /no such field/);
  });
});
