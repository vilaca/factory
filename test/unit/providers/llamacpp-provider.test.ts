import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { LlamaCppProvider } from '../../../src/providers/llamacpp.js';

function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to get server address'));
        return;
      }
      try {
        await fn(`http://127.0.0.1:${address.port}`);
        server.close(err => (err ? reject(err) : resolve()));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe('LlamaCppProvider.listModels', () => {
  it('returns ids from /v1/models when the endpoint is available', async () => {
    await withServer(
      (req, res) => {
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              data: [{ id: 'qwen2.5-coder-32b' }, { id: 'mistral-7b-instruct' }],
            }),
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      },
      async baseUrl => {
        const provider = new LlamaCppProvider(baseUrl);
        const models = await provider.listModels();
        assert.deepStrictEqual(models, ['qwen2.5-coder-32b', 'mistral-7b-instruct']);
      },
    );
  });

  it('falls back to ["default"] when /v1/models returns empty data and /health is OK', async () => {
    await withServer(
      (req, res) => {
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [] }));
        } else if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } else {
          res.writeHead(404);
          res.end();
        }
      },
      async baseUrl => {
        const provider = new LlamaCppProvider(baseUrl);
        const models = await provider.listModels();
        assert.deepStrictEqual(models, ['default']);
      },
    );
  });

  it('falls back to ["default"] when /v1/models is missing and /health is OK', async () => {
    await withServer(
      (req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } else {
          res.writeHead(404);
          res.end();
        }
      },
      async baseUrl => {
        const provider = new LlamaCppProvider(baseUrl);
        const models = await provider.listModels();
        assert.deepStrictEqual(models, ['default']);
      },
    );
  });

  it('throws when /health returns a non-OK status', async () => {
    await withServer(
      (req, res) => {
        if (req.url === '/v1/models') {
          res.writeHead(404);
          res.end();
        } else if (req.url === '/health') {
          res.writeHead(503);
          res.end('unavailable');
        } else {
          res.writeHead(404);
          res.end();
        }
      },
      async baseUrl => {
        const provider = new LlamaCppProvider(baseUrl);
        await assert.rejects(() => provider.listModels(), /not reachable/);
      },
    );
  });
});

describe('LlamaCppProvider.getCapabilities', () => {
  it('returns conservative defaults regardless of model name', () => {
    const caps = new LlamaCppProvider().getCapabilities('whatever');
    assert.strictEqual(caps.contextWindow, 8192);
    assert.strictEqual(caps.maxOutputTokens, 4096);
    assert.strictEqual(caps.toolSupport, 'basic');
    assert.strictEqual(caps.streaming, true);
    assert.strictEqual(caps.modelTier, 'medium');
    assert.strictEqual(caps.parallelToolCalls, false);
    assert.strictEqual(caps.tokenCounting, 'estimated');
  });
});

describe('LlamaCppProvider chat', () => {
  it('streams an OpenAI-compatible /v1/chat/completions response', async () => {
    await withServer(
      (req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          assert.strictEqual(req.method, 'POST');
          assert.strictEqual(req.url, '/v1/chat/completions');
          const payload = JSON.parse(body);
          assert.strictEqual(payload.stream, true);
          // parallelToolCalls=false should NOT appear in the body — buildChatBody
          // omits it when the provider sets the option to false (since OpenAI's
          // default is the same).
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const lines = [
            JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
            JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
          ];
          for (const l of lines) res.write(`data: ${l}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        });
      },
      async baseUrl => {
        const provider = new LlamaCppProvider(baseUrl);
        const chunks = await collect(provider.chat('default', []));
        const text = chunks.map(c => c.content ?? '').join('');
        assert.ok(text.includes('hi'));
        assert.ok(chunks.some(c => c.done));
      },
    );
  });

  it('returns a single chunk via chatNoStream', async () => {
    await withServer(
      (req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          const payload = JSON.parse(body);
          assert.strictEqual(payload.stream, false);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: 'no stream answer' } }],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            }),
          );
        });
      },
      async baseUrl => {
        const provider = new LlamaCppProvider(baseUrl);
        const result = await provider.chatNoStream('default', []);
        assert.strictEqual(result.content, 'no stream answer');
        assert.strictEqual(result.done, true);
        assert.strictEqual(result.usage?.totalTokens, 3);
      },
    );
  });
});
