import { describe, it } from 'node:test';
import assert from 'node:assert';
import { prepareModels } from '../../../../../../src/ui/tui/components/provider-picker/prepare.js';
import type { ModelDisplayInfo } from '../../../../../../src/ui/tui/components/provider-picker/types.js';

function infoFor(map: Record<string, Partial<ModelDisplayInfo>>) {
  return (model: string): ModelDisplayInfo | undefined => {
    const entry = map[model];
    return entry ? { ...entry } : undefined;
  };
}

describe('prepareModels', () => {
  it('sorts by tier descending: strong > medium > weak > undefined', () => {
    const sorted = prepareModels(
      ['weak-1', 'strong-1', 'medium-1', 'unknown-1'],
      infoFor({
        'strong-1': { tier: 'strong' },
        'medium-1': { tier: 'medium' },
        'weak-1': { tier: 'weak' },
        // unknown-1 omitted -> undefined tier
      }),
    );
    assert.deepStrictEqual(sorted, ['strong-1', 'medium-1', 'weak-1', 'unknown-1']);
  });

  it('within a tier, codingSpecialist floats above non-specialists', () => {
    const sorted = prepareModels(
      ['gpt-5.5-pro', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.4-pro'],
      infoFor({
        'gpt-5.5-pro': { tier: 'strong', contextWindow: 1_000_000, maxOutputTokens: 128_000 },
        'gpt-5.4-pro': { tier: 'strong', contextWindow: 1_000_000, maxOutputTokens: 128_000 },
        'gpt-5.3-codex': {
          tier: 'strong',
          contextWindow: 1_000_000,
          maxOutputTokens: 128_000,
          codingSpecialist: true,
        },
        'gpt-5.2-codex': {
          tier: 'strong',
          contextWindow: 1_000_000,
          maxOutputTokens: 128_000,
          codingSpecialist: true,
        },
      }),
    );
    assert.deepStrictEqual(sorted, [
      'gpt-5.3-codex',
      'gpt-5.2-codex',
      'gpt-5.5-pro',
      'gpt-5.4-pro',
    ]);
  });

  it('within a tier, larger context window comes first', () => {
    const sorted = prepareModels(
      ['gpt-4o', 'gpt-5', 'gpt-3.5-turbo'],
      infoFor({
        'gpt-5': { tier: 'strong', contextWindow: 1_000_000 },
        'gpt-4o': { tier: 'strong', contextWindow: 128_000 },
        'gpt-3.5-turbo': { tier: 'strong', contextWindow: 16_000 },
      }),
    );
    assert.deepStrictEqual(sorted, ['gpt-5', 'gpt-4o', 'gpt-3.5-turbo']);
  });

  it('falls back to maxOutputTokens when contextWindow ties', () => {
    const sorted = prepareModels(
      ['gpt-4.1', 'gpt-5'],
      infoFor({
        'gpt-5': { tier: 'strong', contextWindow: 1_000_000, maxOutputTokens: 128_000 },
        'gpt-4.1': { tier: 'strong', contextWindow: 1_000_000, maxOutputTokens: 32_000 },
      }),
    );
    assert.deepStrictEqual(sorted, ['gpt-5', 'gpt-4.1']);
  });

  it('falls back to numeric name compare when capabilities tie', () => {
    const sorted = prepareModels(
      ['claude-sonnet-3-5', 'claude-sonnet-4-5', 'claude-sonnet-4-1'],
      infoFor({
        'claude-sonnet-3-5': { tier: 'strong', contextWindow: 200_000, maxOutputTokens: 16_000 },
        'claude-sonnet-4-5': { tier: 'strong', contextWindow: 200_000, maxOutputTokens: 16_000 },
        'claude-sonnet-4-1': { tier: 'strong', contextWindow: 200_000, maxOutputTokens: 16_000 },
      }),
    );
    assert.deepStrictEqual(sorted, ['claude-sonnet-4-5', 'claude-sonnet-4-1', 'claude-sonnet-3-5']);
  });

  it('uses numeric collation so 4.10 sorts above 4.2', () => {
    const sorted = prepareModels(['gpt-4.2', 'gpt-4.10'], () => ({ tier: 'strong' }));
    assert.deepStrictEqual(sorted, ['gpt-4.10', 'gpt-4.2']);
  });

  it('does not mutate the input array', () => {
    const input = ['a', 'b', 'c'];
    prepareModels(input, () => undefined);
    assert.deepStrictEqual(input, ['a', 'b', 'c']);
  });

  it('falls back to alphabetic-numeric descending when no getModelInfo is provided', () => {
    const sorted = prepareModels(['gpt-3', 'gpt-5', 'gpt-4']);
    assert.deepStrictEqual(sorted, ['gpt-5', 'gpt-4', 'gpt-3']);
  });

  it('handles an empty input', () => {
    assert.deepStrictEqual(
      prepareModels([], () => undefined),
      [],
    );
  });
});
