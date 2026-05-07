import { describe, it } from 'node:test';
import assert from 'node:assert';
import { selectWeakTier } from '../../src/core/agent/weak-tier.js';
import type { Provider, ProviderCapabilities } from '../../src/providers/types.js';

function fakeProvider(name: string, tier: ProviderCapabilities['modelTier']): Provider {
  return {
    name,
    async listModels() {
      return [];
    },
    getCapabilities() {
      return {
        contextWindow: 200000,
        maxOutputTokens: 8192,
        toolSupport: 'native',
        parallelToolCalls: true,
        streaming: true,
        tokenCounting: 'exact',
        modelTier: tier,
      };
    },
    async *chat() {},
    async chatNoStream() {
      return {};
    },
  };
}

describe('selectWeakTier', () => {
  it('returns the mapped weak-tier model for a known strong-tier provider', () => {
    const provider = fakeProvider('anthropic', 'strong');
    assert.strictEqual(selectWeakTier(provider, 'claude-sonnet-4-6'), 'claude-haiku-4-5-20251001');
  });

  it('returns null when the current model is not strong-tier', () => {
    const provider = fakeProvider('anthropic', 'medium');
    assert.strictEqual(selectWeakTier(provider, 'claude-haiku-4-5'), null);
  });

  it('returns null for providers without a curated mapping', () => {
    const provider = fakeProvider('cohere', 'strong');
    assert.strictEqual(selectWeakTier(provider, 'command-r-plus'), null);
  });

  it('returns null when the current model already equals the weak-tier target', () => {
    const provider = fakeProvider('anthropic', 'strong');
    assert.strictEqual(selectWeakTier(provider, 'claude-haiku-4-5-20251001'), null);
  });

  it('returns null when getCapabilities throws', () => {
    const provider: Provider = {
      name: 'anthropic',
      async listModels() {
        return [];
      },
      getCapabilities() {
        throw new Error('boom');
      },
      async *chat() {},
      async chatNoStream() {
        return {};
      },
    };
    assert.strictEqual(selectWeakTier(provider, 'claude-sonnet-4-6'), null);
  });
});
