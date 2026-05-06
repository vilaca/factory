import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  parseSseStream,
  mergeStreamedToolCalls,
  finalizeToolCalls,
  parseToolArgs,
  extractUsage,
  formatMessage,
  buildChatBody,
} from '../../src/providers/_openai/index.js';

function makeReader(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      if (i >= chunks.length) return Promise.resolve({ done: true, value: undefined });
      return Promise.resolve({ done: false, value: encoder.encode(chunks[i++]) });
    },
    cancel: () => Promise.resolve(),
    closed: Promise.resolve(undefined),
    releaseLock: () => {},
  } as any;
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe('parseSseStream', () => {
  it('parses a complete stream of single-line events', async () => {
    const reader = makeReader([
      'data: {"a":1}\n',
      'data: {"b":2}\n',
      'data: [DONE]\n',
    ]);
    const items = await collect(parseSseStream(reader));
    assert.deepStrictEqual(items, [{ a: 1 }, { b: 2 }]);
  });

  it('buffers across chunk boundaries', async () => {
    const reader = makeReader([
      'data: {"a"',
      ':1}\ndata: {',
      '"b":2}\n',
    ]);
    const items = await collect(parseSseStream(reader));
    assert.deepStrictEqual(items, [{ a: 1 }, { b: 2 }]);
  });

  it('skips blank lines and lines without the data: prefix', async () => {
    const reader = makeReader([
      '\n: comment\nevent: foo\ndata: {"ok":true}\n\n',
    ]);
    const items = await collect(parseSseStream(reader));
    assert.deepStrictEqual(items, [{ ok: true }]);
  });

  it('skips lines that fail to JSON-parse rather than throwing', async () => {
    const reader = makeReader([
      'data: not-json\ndata: {"ok":true}\n',
    ]);
    const items = await collect(parseSseStream(reader));
    assert.deepStrictEqual(items, [{ ok: true }]);
  });
});

describe('mergeStreamedToolCalls / finalizeToolCalls', () => {
  it('accumulates a single tool call from name + argument deltas', () => {
    const acc: any[] = [];
    mergeStreamedToolCalls(acc, [{ index: 0, id: 'call_1', function: { name: 'Re', arguments: '{"f' } }]);
    mergeStreamedToolCalls(acc, [{ index: 0, function: { name: 'ad', arguments: 'oo":1}' } }]);
    const finalized = finalizeToolCalls(acc);
    assert.deepStrictEqual(finalized, [{
      id: 'call_1',
      function: { name: 'Read', arguments: { foo: 1 } },
    }]);
  });

  it('handles multiple parallel tool calls by index', () => {
    const acc: any[] = [];
    mergeStreamedToolCalls(acc, [
      { index: 0, id: 'a', function: { name: 'A', arguments: '{}' } },
      { index: 1, id: 'b', function: { name: 'B', arguments: '{}' } },
    ]);
    const finalized = finalizeToolCalls(acc);
    assert.strictEqual(finalized.length, 2);
    assert.strictEqual(finalized[0].id, 'a');
    assert.strictEqual(finalized[1].id, 'b');
  });

  it('drops entries without a function name', () => {
    const acc: any[] = [];
    mergeStreamedToolCalls(acc, [{ index: 0, function: { arguments: '{}' } }]);
    assert.deepStrictEqual(finalizeToolCalls(acc), []);
  });

  it('preserves the raw argument string when JSON parse fails', () => {
    assert.deepStrictEqual(parseToolArgs('not json'), { _raw: 'not json' });
  });

  it('returns {} for missing args', () => {
    assert.deepStrictEqual(parseToolArgs(undefined), {});
    assert.deepStrictEqual(parseToolArgs(''), {});
  });
});

describe('extractUsage', () => {
  it('maps the OpenAI usage shape to TokenUsage', () => {
    const usage = extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
    assert.deepStrictEqual(usage, { promptTokens: 10, completionTokens: 20, totalTokens: 30 });
  });

  it('returns undefined when usage is absent', () => {
    assert.strictEqual(extractUsage({}), undefined);
    assert.strictEqual(extractUsage({ usage: null }), undefined);
  });

  it('defaults missing fields to 0', () => {
    assert.deepStrictEqual(extractUsage({ usage: { prompt_tokens: 5 } }), {
      promptTokens: 5, completionTokens: 0, totalTokens: 0,
    });
  });

  it('extracts cached_tokens from prompt_tokens_details', () => {
    const usage = extractUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    });
    assert.deepStrictEqual(usage, {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedPromptTokens: 80,
    });
  });

  it('omits cachedPromptTokens when prompt_tokens_details is absent', () => {
    const usage = extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    assert.strictEqual((usage as any).cachedPromptTokens, undefined);
  });
});

describe('formatMessage', () => {
  it('formats a plain user message', () => {
    assert.deepStrictEqual(
      formatMessage({ role: 'user', content: 'hi' }),
      { role: 'user', content: 'hi' },
    );
  });

  it('serialises tool_calls with stringified arguments', () => {
    const formatted = formatMessage({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', function: { name: 'Read', arguments: { file: 'x' } } }],
    }) as any;
    assert.strictEqual(formatted.tool_calls[0].id, 'call_1');
    assert.strictEqual(formatted.tool_calls[0].type, 'function');
    assert.strictEqual(formatted.tool_calls[0].function.name, 'Read');
    assert.strictEqual(formatted.tool_calls[0].function.arguments, '{"file":"x"}');
  });

  it('passes tool_call_id through for role=tool', () => {
    const formatted = formatMessage({ role: 'tool', content: 'ok', tool_call_id: 'call_1' });
    assert.strictEqual((formatted as any).tool_call_id, 'call_1');
  });
});

describe('buildChatBody', () => {
  it('emits the canonical body for a streaming chat with tools', () => {
    const body = buildChatBody({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'X', description: '', parameters: {} } }],
      stream: true,
    });
    assert.strictEqual(body.model, 'm');
    assert.strictEqual(body.stream, true);
    assert.strictEqual(body.parallel_tool_calls, true);
    assert.ok(Array.isArray(body.tools));
  });

  it('honours maxTokensField=max_tokens for legacy providers', () => {
    const body = buildChatBody({
      model: 'm', messages: [], stream: false,
      options: { maxTokens: 100 },
      maxTokensField: 'max_tokens',
    });
    assert.strictEqual(body.max_tokens, 100);
    assert.strictEqual(body.max_completion_tokens, undefined);
  });

  it('defaults to max_completion_tokens', () => {
    const body = buildChatBody({
      model: 'm', messages: [], stream: false,
      options: { maxTokens: 200 },
    });
    assert.strictEqual(body.max_completion_tokens, 200);
  });

  it('writes parallel_tool_calls=false explicitly when supplied', () => {
    const body = buildChatBody({
      model: 'm', messages: [], stream: false,
      tools: [{ type: 'function', function: { name: 'X', description: '', parameters: {} } }],
      parallelToolCalls: false,
    });
    assert.strictEqual(body.parallel_tool_calls, false);
  });

  it('merges extra fields', () => {
    const body = buildChatBody({
      model: 'm', messages: [], stream: false,
      extra: { reasoning_effort: 'high' },
    });
    assert.strictEqual(body.reasoning_effort, 'high');
  });

  it('does not emit cache_control fields when cacheControl is off (default)', () => {
    const body = buildChatBody({
      model: 'm',
      messages: [
        { role: 'system', content: 'sys', cacheBoundary: true },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'function', function: { name: 'X', description: '', parameters: {} } }],
      stream: false,
      options: { cacheTools: true },
    });
    assert.strictEqual(JSON.stringify(body).includes('cache_control'), false);
  });

  it('emits cache_control on a message with cacheBoundary when cacheControl is on', () => {
    const body = buildChatBody({
      model: 'anthropic/claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'sys', cacheBoundary: true },
        { role: 'user', content: 'hi' },
      ],
      stream: false,
      cacheControl: true,
    });
    const msgs = body.messages as any[];
    assert.deepStrictEqual(msgs[0].content, [
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
    // Plain user without cacheBoundary stays as string.
    assert.strictEqual(msgs[1].content, 'hi');
  });

  it('emits cache_control on the last tool when cacheTools + cacheControl are both on', () => {
    const body = buildChatBody({
      model: 'anthropic/claude-sonnet-4-6',
      messages: [],
      tools: [
        { type: 'function', function: { name: 'A', description: '', parameters: {} } },
        { type: 'function', function: { name: 'B', description: '', parameters: {} } },
      ],
      stream: false,
      options: { cacheTools: true },
      cacheControl: true,
    });
    const tools = body.tools as any[];
    assert.strictEqual(tools[0].cache_control, undefined);
    assert.deepStrictEqual(tools[1].cache_control, { type: 'ephemeral' });
  });
});
