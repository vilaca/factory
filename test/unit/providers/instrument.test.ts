import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  instrumentProviderRequests,
  type ModelRequestInfo,
} from '../../../src/providers/instrument.js';
import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  Provider,
  ProviderCapabilities,
  ToolDefinition,
} from '../../../src/providers/types.js';

function fakeCaps(): ProviderCapabilities {
  return {
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    toolSupport: 'native',
    parallelToolCalls: true,
    streaming: true,
    tokenCounting: 'estimated',
    modelTier: 'medium',
  };
}

function fakeProvider(name: string, log: { calls: string[] }): Provider {
  async function* stream(): AsyncGenerator<ChatChunk> {
    yield { content: 'hello', done: true };
  }
  return {
    name,
    async listModels() {
      log.calls.push(`${name}:listModels`);
      return ['m1'];
    },
    getCapabilities(_m: string) {
      return fakeCaps();
    },
    async getModelInfo(_m: string) {
      log.calls.push(`${name}:getModelInfo`);
      return { supportsTools: true };
    },
    chat(_model: string, _messages: ChatMessage[], _tools?: ToolDefinition[], _opts?: ChatOptions) {
      log.calls.push(`${name}:chat`);
      return stream();
    },
    async chatNoStream(
      _model: string,
      _messages: ChatMessage[],
      _tools?: ToolDefinition[],
      _opts?: ChatOptions,
    ) {
      log.calls.push(`${name}:chatNoStream`);
      return { content: 'done', done: true } as ChatChunk;
    },
  } as unknown as Provider;
}

describe('instrumentProviderRequests', () => {
  it('fires onRequest before delegating chat() and preserves the stream', async () => {
    const log = { calls: [] as string[] };
    const inner = fakeProvider('inner', log);
    const captured: ModelRequestInfo[] = [];
    const wrapped = instrumentProviderRequests(inner, info => {
      log.calls.push(`onRequest:${info.streaming ? 'stream' : 'oneshot'}`);
      captured.push(info);
    });

    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const tools: ToolDefinition[] = [];
    const opts: ChatOptions = { temperature: 0.7 };

    const chunks: ChatChunk[] = [];
    for await (const c of wrapped.chat('m1', messages, tools, opts)) chunks.push(c);

    // Callback ran BEFORE delegation.
    assert.deepEqual(log.calls, ['onRequest:stream', 'inner:chat']);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.content, 'hello');

    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.source, 'main');
    assert.equal(captured[0]?.streaming, true);
    assert.equal(captured[0]?.provider, 'inner');
    assert.equal(captured[0]?.model, 'm1');
    assert.deepEqual(captured[0]?.messages, messages);
    assert.deepEqual(captured[0]?.tools, tools);
    assert.equal(captured[0]?.options?.temperature, 0.7);
  });

  it('fires onRequest before delegating chatNoStream() and tags streaming=false', async () => {
    const log = { calls: [] as string[] };
    const inner = fakeProvider('inner', log);
    const captured: ModelRequestInfo[] = [];
    const wrapped = instrumentProviderRequests(inner, info => {
      captured.push(info);
    });

    const result = await wrapped.chatNoStream('m1', [{ role: 'user', content: 'x' }]);
    assert.equal(result.content, 'done');
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.streaming, false);
    assert.equal(captured[0]?.source, 'main');
  });

  it('honors the defaultSource override (e.g. compaction)', async () => {
    const log = { calls: [] as string[] };
    const inner = fakeProvider('inner', log);
    const captured: ModelRequestInfo[] = [];
    const wrapped = instrumentProviderRequests(
      inner,
      info => {
        captured.push(info);
      },
      'compaction',
    );
    await wrapped.chatNoStream('m1', [{ role: 'system', content: 'sum' }]);
    assert.equal(captured[0]?.source, 'compaction');
  });

  it('honors `_requestSource` from ChatOptions as a per-call override', async () => {
    const log = { calls: [] as string[] };
    const inner = fakeProvider('inner', log);
    const captured: ModelRequestInfo[] = [];
    // wrap default = 'main'; corrector-style call overrides per-call.
    const wrapped = instrumentProviderRequests(inner, info => {
      captured.push(info);
    });
    await wrapped.chatNoStream('m1', [{ role: 'user', content: 'x' }], undefined, {
      _requestSource: 'corrector',
    });
    await wrapped.chatNoStream('m1', [{ role: 'user', content: 'y' }]);
    assert.equal(captured[0]?.source, 'corrector');
    assert.equal(captured[1]?.source, 'main');
  });

  it('does not break the LLM call when `onRequest` throws (best-effort logging)', async () => {
    const log = { calls: [] as string[] };
    const inner = fakeProvider('inner', log);
    // Throwing onRequest must not propagate out of the wrapper.
    const wrapped = instrumentProviderRequests(inner, () => {
      throw new Error('logger crash');
    });
    // Capture stderr to verify the first failure goes there, then quiets.
    const stderrCalls: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      stderrCalls.push(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = await wrapped.chatNoStream('m1', [{ role: 'user', content: 'x' }]);
      assert.equal(result.content, 'done');
      // Second call still completes; stderr is not spammed.
      const result2 = await wrapped.chatNoStream('m1', [{ role: 'user', content: 'y' }]);
      assert.equal(result2.content, 'done');
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(
      stderrCalls.length,
      1,
      `expected one stderr line, got: ${JSON.stringify(stderrCalls)}`,
    );
    assert.match(stderrCalls[0]!, /model-request logger failed/);
  });

  it('forwards non-chat methods (listModels, getCapabilities, getModelInfo)', async () => {
    const log = { calls: [] as string[] };
    const inner = fakeProvider('inner', log);
    const wrapped = instrumentProviderRequests(inner, () => {});

    const models = await wrapped.listModels();
    assert.deepEqual(models, ['m1']);
    assert.equal(wrapped.name, 'inner');
    const caps = wrapped.getCapabilities('m1');
    assert.equal(caps.contextWindow, 100_000);
    const info = await wrapped.getModelInfo?.('m1');
    assert.equal(info?.supportsTools, true);

    // The wrapper must not have triggered any onRequest for the non-chat
    // methods (they're not LLM calls).
    assert.deepEqual(
      log.calls.filter(c => c.startsWith('onRequest:')),
      [],
    );
  });
});
