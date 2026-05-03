import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { Provider, ChatChunk, ProviderCapabilities } from '../../src/providers/types.js';
import { defaultRegistry } from '../../src/tools/index.js';
import { correctToolCall } from '../../src/core/tool-call-corrector.js';

function providerReturning(content: string): Provider {
  return {
    name: 'mock',
    async listModels() { return []; },
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
    async *chat(): AsyncGenerator<ChatChunk> { yield { done: true }; },
    async chatNoStream(): Promise<ChatChunk> {
      return { content, done: true };
    },
  };
}

function providerAbortingNoStream(): Provider {
  return {
    name: 'mock',
    async listModels() { return []; },
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
    async *chat(): AsyncGenerator<ChatChunk> { yield { done: true }; },
    async chatNoStream(): Promise<ChatChunk> {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
  };
}

describe('correctToolCall', () => {
  it('returns a corrected ToolCallMessage when corrector outputs a valid call', async () => {
    const provider = providerReturning('{"name":"Read","arguments":{"file_path":"/correct/path"}}');
    const result = await correctToolCall(
      {
        originalCall: { function: { name: 'Read', arguments: { file_path: '/wrong/path' } } },
        errorMessage: 'ENOENT: file not found',
      },
      provider,
      'mock-model',
      defaultRegistry,
    );
    assert.strictEqual(result.kind, 'corrected');
    if (result.kind === 'corrected') {
      assert.strictEqual(result.call.function.name, 'Read');
      assert.strictEqual(result.call.function.arguments.file_path, '/correct/path');
    }
  });

  it('aborts when corrector returns explicit abort action', async () => {
    const provider = providerReturning('{"action":"abort","reason":"no idea"}');
    const result = await correctToolCall(
      {
        originalCall: { function: { name: 'Read', arguments: {} } },
        errorMessage: 'something broke',
      },
      provider,
      'mock-model',
      defaultRegistry,
    );
    assert.strictEqual(result.kind, 'abort');
    if (result.kind === 'abort') {
      assert.match(result.reason, /no idea/);
    }
  });

  it('aborts when corrector returns unknown tool name', async () => {
    const provider = providerReturning('{"name":"NotARealTool","arguments":{}}');
    const result = await correctToolCall(
      {
        originalCall: { function: { name: 'Read', arguments: {} } },
        errorMessage: 'x',
      },
      provider,
      'mock-model',
      defaultRegistry,
    );
    assert.strictEqual(result.kind, 'abort');
  });

  it('aborts on unparseable output', async () => {
    const provider = providerReturning('here is some prose, not json');
    const result = await correctToolCall(
      {
        originalCall: { function: { name: 'Read', arguments: {} } },
        errorMessage: 'x',
      },
      provider,
      'mock-model',
      defaultRegistry,
    );
    assert.strictEqual(result.kind, 'abort');
  });

  it('handles JSON wrapped in a ```json fence', async () => {
    const provider = providerReturning('```json\n{"name":"Glob","arguments":{"pattern":"*.ts"}}\n```');
    const result = await correctToolCall(
      {
        originalCall: { function: { name: 'Glob', arguments: { pattern: '*.bad' } } },
        errorMessage: 'no matches',
      },
      provider,
      'mock-model',
      defaultRegistry,
    );
    assert.strictEqual(result.kind, 'corrected');
    if (result.kind === 'corrected') {
      assert.strictEqual(result.call.function.name, 'Glob');
    }
  });

  it('propagates AbortError from chatNoStream instead of returning {kind: abort}', async () => {
    // The user pressed ESC during the corrector's model call. We want the abort
    // to bubble up so the agent loop can yield user-abort, not be flattened
    // into a generic "corrector failed" outcome that lets the agent keep going.
    const provider = providerAbortingNoStream();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => correctToolCall(
        {
          originalCall: { function: { name: 'Read', arguments: {} } },
          errorMessage: 'x',
        },
        provider,
        'mock-model',
        defaultRegistry,
        controller.signal,
      ),
      (err: Error) => err.name === 'AbortError',
    );
  });
});
