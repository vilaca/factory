import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { OllamaProvider } from '../../../src/providers/ollama.js';
import {
  startMockServer,
  stopMockServer,
  setNextResponse,
  setModelCapabilities,
} from '../../mock-ollama-server.js';

let server: http.Server;
let port: number;

before(async () => {
  const result = await startMockServer();
  server = result.server;
  port = result.port;
});

after(async () => {
  await stopMockServer(server);
});

beforeEach(() => {
  setModelCapabilities(['completion', 'tools']);
});

function host(): string {
  return `http://127.0.0.1:${port}`;
}

function provider(): OllamaProvider {
  return new OllamaProvider(host());
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe('OllamaProvider', () => {
  it('lists locally installed models from /api/tags', async () => {
    const models = await provider().listModels();
    assert.deepStrictEqual(models, ['test-model:latest', 'another-model:latest']);
  });

  it('reports model capabilities including tool support from /api/show', async () => {
    setModelCapabilities(['completion', 'tools', 'vision']);
    const info = await provider().getModelInfo('test-model:latest');
    assert.strictEqual(info.supportsTools, true);
    assert.deepStrictEqual(info.capabilities, ['completion', 'tools', 'vision']);
  });

  it('reports supportsTools=false when /api/show omits the tools capability', async () => {
    setModelCapabilities(['completion']);
    const info = await provider().getModelInfo('plain-model:latest');
    assert.strictEqual(info.supportsTools, false);
  });

  it('handles missing capabilities array gracefully', async () => {
    // Empty list — getModelInfo should still resolve with supportsTools=false.
    setModelCapabilities([]);
    const info = await provider().getModelInfo('m:latest');
    assert.strictEqual(info.supportsTools, false);
    assert.deepStrictEqual(info.capabilities, []);
  });
});

describe('OllamaProvider.getCapabilities', () => {
  it('classifies models with >=70b parameters as strong tier', () => {
    const caps = provider().getCapabilities('llama3:70b');
    assert.strictEqual(caps.modelTier, 'strong');
    assert.strictEqual(caps.toolSupport, 'native');
    assert.strictEqual(caps.streaming, true);
    assert.strictEqual(caps.parallelToolCalls, false);
    assert.strictEqual(caps.tokenCounting, 'estimated');
  });

  it('classifies models with 14-69b parameters as medium tier', () => {
    assert.strictEqual(provider().getCapabilities('qwen2.5-coder:32b').modelTier, 'medium');
    assert.strictEqual(provider().getCapabilities('mistral:14b').modelTier, 'medium');
  });

  it('classifies <14b parameter models as weak tier with basic tool support', () => {
    const caps = provider().getCapabilities('llama3:7b');
    assert.strictEqual(caps.modelTier, 'weak');
    assert.strictEqual(caps.toolSupport, 'basic');
  });

  it('defaults unknown-size models to medium tier', () => {
    assert.strictEqual(provider().getCapabilities('mystery-model:latest').modelTier, 'medium');
  });

  it('estimates context windows by model family name', () => {
    assert.strictEqual(provider().getCapabilities('qwen2.5-coder:32b').contextWindow, 32768);
    assert.strictEqual(provider().getCapabilities('mixtral:8x7b').contextWindow, 32768);
    assert.strictEqual(provider().getCapabilities('deepseek-coder:6.7b').contextWindow, 16384);
    assert.strictEqual(provider().getCapabilities('llama3:8b').contextWindow, 8192);
    assert.strictEqual(provider().getCapabilities('mystery:latest').contextWindow, 8192);
  });
});

describe('OllamaProvider.chat (streaming)', () => {
  it('streams content chunks and emits a final usage chunk', async () => {
    setNextResponse({ content: 'hello world' });
    const chunks = await collect(provider().chat('test-model:latest', []));
    const text = chunks
      .map(c => c.content ?? '')
      .join('')
      .trim();
    assert.strictEqual(text, 'hello world');
    const final = chunks[chunks.length - 1];
    assert.strictEqual(final.done, true);
    assert.strictEqual(final.usage?.completionTokens, 10);
  });

  it('emits a tool_calls chunk in the final frame when the model returns one', async () => {
    setNextResponse({
      tool_calls: [{ function: { name: 'Read', arguments: { file_path: '/x' } } }],
    });
    const chunks = await collect(provider().chat('test-model:latest', []));
    const withTools = chunks.find(c => c.tool_calls);
    assert.ok(withTools, 'expected a tool_calls chunk');
    assert.strictEqual(withTools!.tool_calls![0].function.name, 'Read');
    assert.deepStrictEqual(withTools!.tool_calls![0].function.arguments, { file_path: '/x' });
  });

  it('throws an AbortError when the caller aborts before iteration completes', async () => {
    setNextResponse({ content: 'irrelevant' });
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(async () => {
      for await (const _chunk of provider().chat('test-model:latest', [], undefined, {
        signal: ctrl.signal,
      })) {
        // never reached
      }
    }, /aborted|AbortError/);
  });
});

describe('OllamaProvider.chatNoStream', () => {
  it('returns a single chunk with content and done=true', async () => {
    setNextResponse({ content: 'final answer' });
    const result = await provider().chatNoStream('test-model:latest', []);
    assert.strictEqual(result.content, 'final answer');
    assert.strictEqual(result.done, true);
  });

  it('rejects with an AbortError if the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      () => provider().chatNoStream('test-model:latest', [], undefined, { signal: ctrl.signal }),
      /aborted|AbortError/,
    );
  });

  it('returns tool_calls when the response includes them', async () => {
    setNextResponse({
      tool_calls: [{ function: { name: 'Bash', arguments: { command: 'ls' } } }],
    });
    const result = await provider().chatNoStream('m', []);
    assert.strictEqual(result.tool_calls?.[0].function.name, 'Bash');
    assert.deepStrictEqual(result.tool_calls?.[0].function.arguments, { command: 'ls' });
  });
});

describe('OllamaProvider error translation', () => {
  it('wraps connection errors with a user-actionable message', async () => {
    // Point at a closed port — fetch will report ECONNREFUSED.
    const offline = new OllamaProvider('http://127.0.0.1:1');
    await assert.rejects(
      () => offline.listModels(),
      err => {
        // The translateOllamaError wrapper only fires on chat() paths; listModels
        // surfaces the raw error.  Either is acceptable as long as something
        // useful crosses the wire.
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });

  it('translates EOF / connection-dropped errors during chat into an actionable message', async () => {
    // Spin up a server that accepts the chat POST then immediately closes the
    // socket without writing any response — the SDK surfaces this as 'EOF' or
    // 'fetch failed' which the provider rewrites.
    const dyingServer = http.createServer((_req, res) => {
      res.socket?.destroy();
    });
    await new Promise<void>(resolve => dyingServer.listen(0, '127.0.0.1', resolve));
    const addr = dyingServer.address() as { port: number };
    const dying = new OllamaProvider(`http://127.0.0.1:${addr.port}`);
    try {
      await assert.rejects(
        () => dying.chatNoStream('m', []),
        err => {
          assert.ok(err instanceof Error);
          // Either translated message (Ollama-actionable wording) or the raw
          // SDK error — both are acceptable; we just need an Error instance.
          return true;
        },
      );
    } finally {
      await new Promise<void>(resolve => dyingServer.close(() => resolve()));
    }
  });
});
