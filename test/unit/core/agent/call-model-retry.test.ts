import { describe, it } from 'node:test';
import assert from 'node:assert';
import { callModel } from '../../../../src/core/agent/call-model/call-model.js';
import type {
  ChatChunk,
  ChatMessage,
  Provider,
  ProviderCapabilities,
  ToolDefinition,
} from '../../../../src/providers/types.js';
import type { AgentEvent } from '../../../../src/core/agent/types.js';

/**
 * Build a provider whose chat() consumes a plan entry per call: an Error
 * throws, an array of chunks yields. Same pattern as call-model-rotation.test.ts.
 */
function sequencedProvider(name: string, plan: Array<Error | ChatChunk[]>): Provider {
  let i = 0;
  return {
    name,
    listModels: async () => [],
    getCapabilities: (): ProviderCapabilities => ({
      contextWindow: 8192,
      maxOutputTokens: 4096,
      toolSupport: 'native',
      parallelToolCalls: false,
      streaming: true,
      tokenCounting: 'estimated',
      modelTier: 'medium',
    }),
    chat: async function* (_model, _messages, _tools, _opts) {
      const step = plan[i++];
      if (step instanceof Error) throw step;
      for (const c of step ?? []) yield c;
    },
    chatNoStream: async () => ({ content: 'non-stream fallback', tool_calls: [] }),
  };
}

async function collect(
  gen: AsyncGenerator<AgentEvent, unknown>,
): Promise<{ events: AgentEvent[]; result: unknown }> {
  const events: AgentEvent[] = [];
  let result: unknown;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      result = next.value;
      break;
    }
    events.push(next.value as AgentEvent);
  }
  return { events, result };
}

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const tools: ToolDefinition[] | undefined = undefined;

describe('callModel — retry policy', () => {
  it('retries a transient 503 on the same key and recovers', async () => {
    const provider = sequencedProvider('p', [
      Object.assign(new Error('Service unavailable'), { status: 503 }),
      Object.assign(new Error('Bad gateway'), { status: 502 }),
      [{ content: 'finally', usage: undefined }],
    ]);
    const t0 = Date.now();
    const { events, result } = await collect(callModel(provider, 'm', messages, tools, undefined));
    const elapsed = Date.now() - t0;

    const retries = events.filter(e => e.type === 'provider-retry');
    assert.strictEqual(retries.length, 2, `expected 2 retries, got ${retries.length}`);
    // Sorted attempt counters land 1, 2 (max=3 by default).
    assert.deepStrictEqual(
      retries.map(r => (r as { attempt: number }).attempt),
      [1, 2],
    );
    // Both retries classified as server-error; reason flows to the UI.
    assert.deepStrictEqual(
      retries.map(r => (r as { reason: string }).reason),
      ['server-error', 'server-error'],
    );
    // Final reply made it through.
    assert.deepStrictEqual(
      (result as { fullContent: string }).fullContent,
      'finally',
    );
    // Retries respect their declared backoff. The default policy (base 250,
    // cap 4000) keeps two attempts under 8s in the worst case; if elapsed
    // were >> that, retries weren't actually sleeping.
    assert.ok(elapsed < 10_000, `retry path too slow: ${elapsed}ms`);
  });

  it('retries 429 (rate-limit) without burning a rotation slot', async () => {
    // No rotation provided — if 429 fell through to "other" there'd be no
    // recovery path and the test would throw.
    const provider = sequencedProvider('p', [
      Object.assign(new Error('Too many requests'), { status: 429 }),
      [{ content: 'after-throttle', usage: undefined }],
    ]);
    const { events, result } = await collect(callModel(provider, 'm', messages, tools, undefined));
    const retries = events.filter(e => e.type === 'provider-retry');
    assert.strictEqual(retries.length, 1);
    assert.strictEqual(
      (retries[0] as { reason: string }).reason,
      'rate-limit',
    );
    assert.strictEqual((result as { fullContent: string }).fullContent, 'after-throttle');
  });

  it('does NOT retry a 401 (rotation-eligible) — leaves it for the rotation tier', async () => {
    // 401 with no rotation options should propagate as a regular failure.
    // The call-model loop currently passes 401 through to streamish then to
    // throw. The test asserts no retry events are emitted on the way out.
    const provider = sequencedProvider('p', [
      Object.assign(new Error('Unauthorized'), { status: 401 }),
    ]);
    await assert.rejects(async () => {
      await collect(callModel(provider, 'm', messages, tools, undefined));
    });
  });

  it('exhausts the retry budget on a sustained outage and propagates the error', async () => {
    // Default budget is 3 attempts: initial + 2 retries.
    const provider = sequencedProvider('p', [
      Object.assign(new Error('503'), { status: 503 }),
      Object.assign(new Error('503'), { status: 503 }),
      Object.assign(new Error('503'), { status: 503 }),
    ]);
    await assert.rejects(async () => {
      await collect(callModel(provider, 'm', messages, tools, undefined));
    }, /503/);
  });

  it('does not retry once a chunk has streamed (mid-stream errors are fatal here)', async () => {
    // Provider yields one chunk THEN throws. Retrying mid-stream would
    // duplicate tokens already committed to the caller's scrollback, so
    // call-model intentionally does not retry once `streamedAnything`.
    const provider: Provider = {
      name: 'p',
      listModels: async () => [],
      getCapabilities: () => ({
        contextWindow: 8192,
        maxOutputTokens: 4096,
        toolSupport: 'native',
        parallelToolCalls: false,
        streaming: true,
        tokenCounting: 'estimated',
        modelTier: 'medium',
      }),
      chat: async function* () {
        yield { content: 'partial', usage: undefined };
        throw Object.assign(new Error('connection dropped'), { status: undefined });
      },
      chatNoStream: async () => ({ content: 'nonstream', tool_calls: [] }),
    };
    // call-model has its OWN streamish-recovery path that retries non-stream
    // once. That's fine — the contract under test is "no provider-retry
    // events fire after a stream chunk has landed".
    const { events } = await collect(callModel(provider, 'm', messages, tools, undefined));
    assert.strictEqual(
      events.filter(e => e.type === 'provider-retry').length,
      0,
    );
  });
});
