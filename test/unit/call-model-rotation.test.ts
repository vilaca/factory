import { describe, it } from 'node:test';
import assert from 'node:assert';
import { callModel } from '../../src/core/agent/call-model.js';
import type { ProviderKey } from '../../src/core/config-types.js';
import type { ChatChunk, ChatMessage, Provider, ProviderCapabilities, ToolDefinition } from '../../src/providers/types.js';
import type { AgentEvent, RotationOptions } from '../../src/core/agent-types.js';

/**
 * Build a Provider whose chat() yields the supplied chunks (or throws when
 * the entry is an Error). Useful for stitching together a sequence of
 * call-model invocations: each call consumes the next entry.
 */
function buildSequencedProvider(name: string, plan: Array<Error | ChatChunk[]>): Provider {
  let i = 0;
  return {
    name,
    listModels: async () => [],
    getCapabilities: (): ProviderCapabilities => ({ contextWindow: 8192, modelTier: 'medium' }),
    chat: async function* (_model, _messages, _tools, _opts) {
      const step = plan[i++];
      if (step instanceof Error) throw step;
      for (const c of step ?? []) yield c;
    },
    chatNoStream: async () => ({ content: 'fallback', tool_calls: [] }),
  };
}

function key(id: string, token: string, createdAt = '2024-01-01T00:00:00Z'): ProviderKey {
  return { id, token, createdAt };
}

async function collect(gen: AsyncGenerator<AgentEvent, unknown>): Promise<{ events: AgentEvent[]; result: unknown }> {
  const events: AgentEvent[] = [];
  let result: unknown;
  while (true) {
    const next = await gen.next();
    if (next.done) { result = next.value; break; }
    events.push(next.value as AgentEvent);
  }
  return { events, result };
}

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const tools: ToolDefinition[] | undefined = undefined;

describe('callModel rotation (tier 1)', () => {
  it('rotates to the next key on a 429 thrown before any chunk', async () => {
    // First chat() throws a 429-shaped error; second yields a clean reply.
    const initial = buildSequencedProvider('anthropic', [
      Object.assign(new Error('429 Too Many Requests'), { status: 429 }),
    ]);
    const replacement = buildSequencedProvider('anthropic', [
      [{ content: 'rotated reply', usage: undefined }],
    ]);
    const keys: ProviderKey[] = [
      key('a', 'tok-a'),
      key('b', 'tok-b'),
    ];
    let withKeyCalledFor: string | undefined;
    const rotation: RotationOptions = {
      keys,
      activeKeyId: 'a',
      withKey: (k) => { withKeyCalledFor = k.id; return replacement; },
    };

    const { events, result } = await collect(callModel(initial, 'm', messages, tools, undefined, rotation));

    // Saw a key-rotation event, then text from the new provider.
    const rotEvent = events.find(e => e.type === 'key-rotation');
    assert.ok(rotEvent, 'expected key-rotation event');
    assert.strictEqual(rotEvent.type === 'key-rotation' && rotEvent.from?.keyId, 'a');
    assert.strictEqual(rotEvent.type === 'key-rotation' && rotEvent.to.keyId, 'b');
    assert.strictEqual(rotEvent.type === 'key-rotation' && rotEvent.reason, 'rate-limit');
    assert.strictEqual(withKeyCalledFor, 'b');
    assert.strictEqual((result as { fullContent: string }).fullContent, 'rotated reply');
    // Final provider was rotated, and it differs from the initial one.
    assert.notStrictEqual((result as { finalProvider?: Provider }).finalProvider, initial);
  });

  it('exhausts all keys and surfaces the original 429 when each fails', async () => {
    // First call (initial provider) throws.
    const err = Object.assign(new Error('429'), { status: 429 });
    const initial = buildSequencedProvider('anthropic', [err]);
    // Replacement also throws — both keys exhausted.
    const replacement = buildSequencedProvider('anthropic', [err]);
    const rotation: RotationOptions = {
      keys: [key('a', 'tok-a'), key('b', 'tok-b')],
      activeKeyId: 'a',
      withKey: () => replacement,
    };

    let caught: unknown;
    const events: AgentEvent[] = [];
    try {
      const gen = callModel(initial, 'm', messages, tools, undefined, rotation);
      while (true) {
        const next = await gen.next();
        if (next.done) break;
        events.push(next.value as AgentEvent);
      }
    } catch (e) {
      caught = e;
    }

    // Saw one rotation event, then a key-rotation-exhausted event, then the
    // original error propagated.
    assert.strictEqual(events.filter(e => e.type === 'key-rotation').length, 1);
    assert.strictEqual(events.filter(e => e.type === 'key-rotation-exhausted').length, 1);
    assert.ok(caught instanceof Error);
    assert.match((caught as Error).message, /429/);
  });

  it('does not rotate on transport errors (non-rotatable)', async () => {
    const initial = buildSequencedProvider('anthropic', [new Error('socket hang up')]);
    const replacement = buildSequencedProvider('anthropic', [
      [{ content: 'should not see this', usage: undefined }],
    ]);
    const rotation: RotationOptions = {
      keys: [key('a', 'tok-a'), key('b', 'tok-b')],
      activeKeyId: 'a',
      withKey: () => replacement,
    };

    // 'socket hang up' is matched as "isStreamish" and falls back to
    // chatNoStream on the *initial* provider (not a key rotation).
    const { events, result } = await collect(callModel(initial, 'm', messages, tools, undefined, rotation));
    assert.strictEqual(events.find(e => e.type === 'key-rotation'), undefined);
    assert.strictEqual((result as { fullContent: string }).fullContent, 'fallback');
  });

  it('skips rotation when activeKeyId is unknown', async () => {
    const initial = buildSequencedProvider('anthropic', [
      Object.assign(new Error('429'), { status: 429 }),
    ]);
    const rotation: RotationOptions = {
      keys: [key('a', 'tok-a'), key('b', 'tok-b')],
      activeKeyId: undefined, // <-- unknown
      withKey: () => initial,
    };
    let caught: unknown;
    try {
      const gen = callModel(initial, 'm', messages, tools, undefined, rotation);
      while (true) {
        const next = await gen.next();
        if (next.done) break;
      }
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error);
    assert.match((caught as Error).message, /429/);
  });

  it('falls back to the next chain entry when keys exhaust on the current tuple', async () => {
    // First call (anthropic, sonnet) throws. No more keys to rotate.
    // Tier 2 advances to (groq, llama). New provider yields a clean reply.
    const initial = buildSequencedProvider('anthropic', [
      Object.assign(new Error('429'), { status: 429 }),
    ]);
    const fallback = buildSequencedProvider('groq', [
      [{ content: 'fallback reply', usage: undefined }],
    ]);
    let loadKeysCalledFor: string | undefined;
    let withTupleCalledFor: string | undefined;
    const rotation: RotationOptions = {
      keys: [key('a', 'tok-a')], // single key, no tier-1 alternative
      activeKeyId: 'a',
      withKey: () => initial, // tier-1 has no fallback
      modelsEnabled: true,
      chain: [{ provider: 'groq', model: 'llama-3.3-70b' }],
      loadKeysForProvider: async (p) => {
        loadKeysCalledFor = p;
        return [key('g', 'tok-g')];
      },
      withTuple: (p, _k) => {
        withTupleCalledFor = p;
        return fallback;
      },
    };

    const { events, result } = await collect(
      callModel(initial, 'claude-sonnet', messages, tools, undefined, rotation),
    );

    // Should see key-rotation-exhausted (tier 1 had nothing), then
    // tuple-rotation (tier 2), then content from the fallback.
    assert.ok(events.find(e => e.type === 'key-rotation-exhausted'), 'expected key-rotation-exhausted');
    const tupEvent = events.find(e => e.type === 'tuple-rotation');
    assert.ok(tupEvent, 'expected tuple-rotation');
    assert.strictEqual(tupEvent.type === 'tuple-rotation' && tupEvent.from.provider, 'anthropic');
    assert.strictEqual(tupEvent.type === 'tuple-rotation' && tupEvent.to.provider, 'groq');
    assert.strictEqual(tupEvent.type === 'tuple-rotation' && tupEvent.to.model, 'llama-3.3-70b');
    assert.strictEqual(loadKeysCalledFor, 'groq');
    assert.strictEqual(withTupleCalledFor, 'groq');
    const r = result as { fullContent: string; finalProvider?: Provider; finalModel?: string };
    assert.strictEqual(r.fullContent, 'fallback reply');
    assert.strictEqual(r.finalModel, 'llama-3.3-70b');
    assert.notStrictEqual(r.finalProvider, initial);
  });

  it('exhausts the chain when every entry also fails', async () => {
    const err = Object.assign(new Error('429'), { status: 429 });
    const initial = buildSequencedProvider('anthropic', [err]);
    const fallback1 = buildSequencedProvider('groq', [err]);
    const fallback2 = buildSequencedProvider('cerebras', [err]);
    const tupleProviders: Record<string, Provider> = {
      groq: fallback1,
      cerebras: fallback2,
    };
    const rotation: RotationOptions = {
      keys: [key('a', 'tok-a')],
      activeKeyId: 'a',
      withKey: () => initial,
      modelsEnabled: true,
      chain: [
        { provider: 'groq', model: 'llama-3.3-70b' },
        { provider: 'cerebras', model: 'gpt-oss-120b' },
      ],
      loadKeysForProvider: async () => [key('x', 'tok-x')],
      withTuple: (p) => tupleProviders[p]!,
    };

    let caught: unknown;
    const events: AgentEvent[] = [];
    try {
      const gen = callModel(initial, 'claude-sonnet', messages, tools, undefined, rotation);
      while (true) {
        const next = await gen.next();
        if (next.done) break;
        events.push(next.value as AgentEvent);
      }
    } catch (e) {
      caught = e;
    }

    // Saw two tuple-rotations (sonnet → llama → cerebras), then a final
    // tuple-rotation-exhausted, then the error propagated.
    assert.strictEqual(events.filter(e => e.type === 'tuple-rotation').length, 2);
    assert.strictEqual(events.filter(e => e.type === 'tuple-rotation-exhausted').length, 1);
    assert.ok(caught instanceof Error);
  });

  it('skips chain entries with no saved keys', async () => {
    const err = Object.assign(new Error('429'), { status: 429 });
    const initial = buildSequencedProvider('anthropic', [err]);
    const fallback = buildSequencedProvider('cerebras', [
      [{ content: 'ok', usage: undefined }],
    ]);
    const rotation: RotationOptions = {
      keys: [key('a', 'tok-a')],
      activeKeyId: 'a',
      withKey: () => initial,
      modelsEnabled: true,
      chain: [
        { provider: 'groq', model: 'llama-3.3-70b' },     // empty keys, skipped
        { provider: 'cerebras', model: 'gpt-oss-120b' },  // valid
      ],
      loadKeysForProvider: async (p) => p === 'groq' ? [] : [key('x', 'tok-x')],
      withTuple: (p) => p === 'cerebras' ? fallback : initial,
    };

    const { events, result } = await collect(
      callModel(initial, 'claude-sonnet', messages, tools, undefined, rotation),
    );
    const tupEvent = events.find(e => e.type === 'tuple-rotation');
    assert.ok(tupEvent);
    assert.strictEqual(tupEvent.type === 'tuple-rotation' && tupEvent.to.provider, 'cerebras');
    assert.strictEqual((result as { fullContent: string }).fullContent, 'ok');
  });

  it('does not advance when modelsEnabled is false even with a chain present', async () => {
    const err = Object.assign(new Error('429'), { status: 429 });
    const initial = buildSequencedProvider('anthropic', [err]);
    const rotation: RotationOptions = {
      keys: [key('a', 'tok-a')],
      activeKeyId: 'a',
      withKey: () => initial,
      modelsEnabled: false, // <-- disabled
      chain: [{ provider: 'groq', model: 'llama-3.3-70b' }],
      loadKeysForProvider: async () => [key('x', 'tok-x')],
      withTuple: () => initial,
    };
    let caught: unknown;
    try {
      const gen = callModel(initial, 'claude-sonnet', messages, tools, undefined, rotation);
      while (true) {
        const n = await gen.next();
        if (n.done) break;
      }
    } catch (e) { caught = e; }
    assert.ok(caught instanceof Error);
  });

  it('updates failureLog when rotating', async () => {
    const initial = buildSequencedProvider('anthropic', [
      Object.assign(new Error('429'), { status: 429 }),
    ]);
    const replacement = buildSequencedProvider('anthropic', [
      [{ content: 'ok', usage: undefined }],
    ]);
    const failureLog = new Map<string, number>();
    const rotation: RotationOptions = {
      keys: [key('a', 'tok-a'), key('b', 'tok-b')],
      activeKeyId: 'a',
      withKey: () => replacement,
      failureLog,
    };
    await collect(callModel(initial, 'm', messages, tools, undefined, rotation));
    assert.ok(failureLog.has('a'));
  });
});
