import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { HuggingFaceProvider } from '../../src/providers/huggingface.js';

// HuggingFaceProvider's constructor instantiates an InferenceClient with
// non-configurable methods, and the SDK ultimately calls globalThis.fetch
// against a fixed router.huggingface.co URL. We stub globalThis.fetch to
// return canned responses — both streaming (NDJSON) and non-streaming
// (JSON) — so the provider's transformation pipeline runs end-to-end
// against deterministic input without ever opening a socket.
function provider(): HuggingFaceProvider {
  return new HuggingFaceProvider('hf_test_token');
}

let originalFetch: typeof globalThis.fetch;

before(() => {
  originalFetch = globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

function stubChatCompletion(response: Record<string, unknown>): void {
  // The SDK's ChatCompletionOutput validator demands choices/created/id/model/usage
  // — we shim missing fields so callers can write minimal fixtures.
  const padded = {
    id: 'cmpl-test',
    created: Math.floor(Date.now() / 1000),
    model: 'm',
    usage: null,
    ...response,
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(padded), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch;
}

function stubChatCompletionStream(frames: unknown[]): void {
  globalThis.fetch = (async () => {
    const lines = frames.map(f => `data: ${JSON.stringify(f)}\n\n`);
    lines.push('data: [DONE]\n\n');
    const body = new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(new TextEncoder().encode(line));
        }
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof globalThis.fetch;
}

function stubFetchThrows(error: Error): void {
  globalThis.fetch = (async () => {
    throw error;
  }) as typeof globalThis.fetch;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe('HuggingFaceProvider construction', () => {
  it('throws if no token is passed and HF_TOKEN / HUGGING_FACE_HUB_TOKEN are unset', () => {
    const prevHf = process.env.HF_TOKEN;
    const prevHub = process.env.HUGGING_FACE_HUB_TOKEN;
    delete process.env.HF_TOKEN;
    delete process.env.HUGGING_FACE_HUB_TOKEN;
    try {
      assert.throws(() => new HuggingFaceProvider(), /HuggingFace token required/);
    } finally {
      if (prevHf !== undefined) process.env.HF_TOKEN = prevHf;
      if (prevHub !== undefined) process.env.HUGGING_FACE_HUB_TOKEN = prevHub;
    }
  });

  it('falls back to HF_TOKEN env var', () => {
    const prev = process.env.HF_TOKEN;
    process.env.HF_TOKEN = 'env-token';
    try {
      assert.doesNotThrow(() => new HuggingFaceProvider());
    } finally {
      if (prev === undefined) delete process.env.HF_TOKEN;
      else process.env.HF_TOKEN = prev;
    }
  });

  it('falls back to HUGGING_FACE_HUB_TOKEN when HF_TOKEN is unset', () => {
    const prevHf = process.env.HF_TOKEN;
    const prevHub = process.env.HUGGING_FACE_HUB_TOKEN;
    delete process.env.HF_TOKEN;
    process.env.HUGGING_FACE_HUB_TOKEN = 'hub-token';
    try {
      assert.doesNotThrow(() => new HuggingFaceProvider());
    } finally {
      if (prevHf !== undefined) process.env.HF_TOKEN = prevHf;
      if (prevHub === undefined) delete process.env.HUGGING_FACE_HUB_TOKEN;
      else process.env.HUGGING_FACE_HUB_TOKEN = prevHub;
    }
  });
});

describe('HuggingFaceProvider.listModels', () => {
  it('returns a curated list of chat-capable model ids', async () => {
    const models = await provider().listModels();
    assert.ok(models.includes('Qwen/Qwen2.5-Coder-32B-Instruct'));
    assert.ok(models.includes('meta-llama/Llama-3.3-70B-Instruct'));
    assert.ok(models.length >= 5);
  });
});

describe('HuggingFaceProvider.getCapabilities', () => {
  it('classifies >=70b models as strong tier', () => {
    const caps = provider().getCapabilities('meta-llama/Llama-3.3-70B-Instruct');
    assert.strictEqual(caps.modelTier, 'strong');
    assert.strictEqual(caps.toolSupport, 'basic');
    assert.strictEqual(caps.streaming, true);
  });

  it('classifies 14-69b models as medium', () => {
    assert.strictEqual(
      provider().getCapabilities('Qwen/Qwen2.5-Coder-32B-Instruct').modelTier,
      'medium',
    );
  });

  it('classifies <14b models as weak', () => {
    assert.strictEqual(
      provider().getCapabilities('meta-llama/Llama-3.1-8B-Instruct').modelTier,
      'weak',
    );
  });

  it('defaults param-less model names to medium', () => {
    assert.strictEqual(
      provider().getCapabilities('microsoft/Phi-3-mini-4k-instruct').modelTier,
      'medium',
    );
  });

  it('estimates context windows by family', () => {
    assert.strictEqual(
      provider().getCapabilities('Qwen/Qwen2.5-Coder-32B-Instruct').contextWindow,
      32768,
    );
    assert.strictEqual(
      provider().getCapabilities('meta-llama/Llama-3.3-70B-Instruct').contextWindow,
      8192,
    );
    assert.strictEqual(
      provider().getCapabilities('mistralai/Mixtral-8x7B-Instruct-v0.1').contextWindow,
      32768,
    );
    assert.strictEqual(
      provider().getCapabilities('microsoft/Phi-3-mini-4k-instruct').contextWindow,
      4096,
    );
    assert.strictEqual(provider().getCapabilities('mystery/Model').contextWindow, 8192);
  });
});

describe('HuggingFaceProvider.chat (streaming)', () => {
  let p: HuggingFaceProvider;
  beforeEach(() => {
    p = provider();
  });

  it('forwards content deltas as ChatChunk.content', async () => {
    stubChatCompletionStream([
      { choices: [{ delta: { content: 'hello ' } }] },
      { choices: [{ delta: { content: 'world' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const chunks = await collect(p.chat('m', []));
    const text = chunks
      .map(c => c.content ?? '')
      .join('')
      .trim();
    assert.strictEqual(text, 'hello world');
    assert.ok(chunks.some(c => c.done));
  });

  it('aggregates streamed tool_call deltas and emits a final tool_calls chunk', async () => {
    stubChatCompletionStream([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call-1', function: { name: 'Read', arguments: '{"file_pa' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'th":"/x"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]);
    const chunks = await collect(p.chat('m', []));
    const final = chunks.find(c => c.tool_calls);
    assert.ok(final, 'expected a final tool_calls chunk');
    assert.strictEqual(final!.tool_calls![0].function.name, 'Read');
    assert.deepStrictEqual(final!.tool_calls![0].function.arguments, { file_path: '/x' });
  });

  it('rejects with AbortError when signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      () => collect(p.chat('m', [], undefined, { signal: ctrl.signal })),
      /HuggingFace API error/,
    );
  });

  it('wraps SDK errors with a HuggingFace API error prefix', async () => {
    stubFetchThrows(new Error('429 too many requests'));
    await assert.rejects(() => collect(p.chat('m', [])), /HuggingFace API error.*429/);
  });
});

describe('HuggingFaceProvider.chatNoStream', () => {
  it('returns a single chunk with content + usage when the SDK responds', async () => {
    const p = provider();
    stubChatCompletion({
      choices: [{ message: { content: 'final answer' } }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    });
    const result = await p.chatNoStream('m', []);
    assert.strictEqual(result.content, 'final answer');
    assert.strictEqual(result.done, true);
    assert.deepStrictEqual(result.usage, {
      promptTokens: 5,
      completionTokens: 7,
      totalTokens: 12,
    });
  });

  it('parses string-encoded tool_call arguments', async () => {
    const p = provider();
    stubChatCompletion({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call-1',
                function: { name: 'Bash', arguments: '{"command":"ls"}' },
              },
            ],
          },
        },
      ],
    });
    const result = await p.chatNoStream('m', []);
    assert.strictEqual(result.tool_calls?.[0].function.name, 'Bash');
    assert.deepStrictEqual(result.tool_calls?.[0].function.arguments, { command: 'ls' });
  });

  it('passes through already-parsed object arguments', async () => {
    const p = provider();
    stubChatCompletion({
      choices: [
        {
          message: {
            tool_calls: [{ id: 'c2', function: { name: 'Read', arguments: { file_path: '/y' } } }],
          },
        },
      ],
    });
    const result = await p.chatNoStream('m', []);
    assert.deepStrictEqual(result.tool_calls?.[0].function.arguments, { file_path: '/y' });
  });

  it('omits usage when SDK response has none', async () => {
    const p = provider();
    stubChatCompletion({ choices: [{ message: { content: 'no usage' } }] });
    const result = await p.chatNoStream('m', []);
    assert.strictEqual(result.usage, undefined);
  });
});
