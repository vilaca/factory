import { describe, it } from 'node:test';
import assert from 'node:assert';
import type {
  Provider,
  ChatMessage,
  ChatChunk,
  ProviderCapabilities,
  ModelInfo,
} from '../../../../src/providers/types.js';
import { validateModelToolSupport } from '../../../../src/core/auth/model-validation.js';

function baseProvider(): Provider {
  return {
    name: 'mock',
    async listModels() {
      return [];
    },
    getCapabilities(): ProviderCapabilities {
      return {
        contextWindow: 8192,
        maxOutputTokens: 4096,
        toolSupport: 'native',
        parallelToolCalls: false,
        streaming: true,
        tokenCounting: 'estimated',
        modelTier: 'medium',
      };
    },
    async *chat(_m: string, _msgs: ChatMessage[]): AsyncGenerator<ChatChunk> {
      yield { done: true };
    },
    async chatNoStream(): Promise<ChatChunk> {
      return { done: true };
    },
  };
}

describe('validateModelToolSupport', () => {
  it('returns native when provider does not implement getModelInfo', async () => {
    const result = await validateModelToolSupport(baseProvider(), 'any-model');
    assert.deepStrictEqual(result, { mode: 'native' });
  });

  it('returns native when model supports tools', async () => {
    const provider: Provider = {
      ...baseProvider(),
      async getModelInfo(): Promise<ModelInfo> {
        return { supportsTools: true, capabilities: ['completion', 'tools'] };
      },
    };
    const result = await validateModelToolSupport(provider, 'good-model');
    assert.deepStrictEqual(result, { mode: 'native' });
  });

  it('returns fallback when model lacks tool support', async () => {
    const provider: Provider = {
      ...baseProvider(),
      async getModelInfo(): Promise<ModelInfo> {
        return { supportsTools: false, capabilities: ['completion'] };
      },
    };
    const result = await validateModelToolSupport(provider, 'toolless-model');
    assert.strictEqual(result.mode, 'fallback');
    if (result.mode === 'fallback') {
      assert.match(result.warning, /toolless-model/);
      assert.match(result.warning, /text-based/);
    }
  });

  it('returns unreachable when getModelInfo throws', async () => {
    const provider: Provider = {
      ...baseProvider(),
      async getModelInfo(): Promise<ModelInfo> {
        throw new Error('connection refused');
      },
    };
    const result = await validateModelToolSupport(provider, 'unreachable');
    assert.strictEqual(result.mode, 'unreachable');
    if (result.mode === 'unreachable') {
      assert.match(result.reason, /connection refused/);
    }
  });
});
