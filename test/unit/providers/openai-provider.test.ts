import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { OpenAIProvider } from '../../../src/providers/openai/index.js';

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
        await fn(`http://127.0.0.1:${address.port}/v1`);
        server.close(err => (err ? reject(err) : resolve()));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

describe('OpenAIProvider', () => {
  it('throws when no token is provided and OPENAI_API_KEY is unset', () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      assert.throws(() => new OpenAIProvider(), /OPENAI_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });

  it('lists chat models and filters out non-chat endpoints', async () => {
    await withServer(
      (req, res) => {
        assert.strictEqual(req.method, 'GET');
        assert.strictEqual(req.url, '/v1/models');
        assert.strictEqual(req.headers.authorization, 'Bearer test-token');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              { id: 'gpt-5', object: 'model', owned_by: 'openai' },
              { id: 'gpt-4o', object: 'model', owned_by: 'openai' },
              { id: 'o4-mini', object: 'model', owned_by: 'openai' },
              // These should all be filtered out by supportsChatCompletions:
              { id: 'whisper-1', object: 'model', owned_by: 'openai' },
              { id: 'tts-1', object: 'model', owned_by: 'openai' },
              { id: 'text-embedding-3-large', object: 'model', owned_by: 'openai' },
              { id: 'dall-e-3', object: 'model', owned_by: 'openai' },
              { id: 'omni-moderation-latest', object: 'model', owned_by: 'openai' },
              { id: 'gpt-4o-realtime-preview', object: 'model', owned_by: 'openai' },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new OpenAIProvider({ token: 'test-token', host: baseUrl });
        const models = await provider.listModels();
        assert.deepStrictEqual(models, ['gpt-5', 'gpt-4o', 'o4-mini']);
      },
    );
  });

  it('builds picker details that flag reasoning, vision, and tier', async () => {
    const provider = new OpenAIProvider({ token: 'test-token', host: 'http://unused' });

    const gpt5 = provider.getModelPickerInfo('gpt-5');
    assert.strictEqual(gpt5.label, 'gpt-5');
    assert.match(gpt5.detail!, /vision/);
    assert.match(gpt5.detail!, /tools/);
    assert.match(gpt5.detail!, /reasoning/);
    assert.match(gpt5.detail!, /1M ctx/);

    const o4 = provider.getModelPickerInfo('o4-mini');
    assert.match(o4.detail!, /reasoning/);

    const gpt4o = provider.getModelPickerInfo('gpt-4o');
    assert.doesNotMatch(gpt4o.detail!, /reasoning/);
    assert.match(gpt4o.detail!, /128k ctx/);

    // Deprecated 3.5/4 lines surface a warning so users see them as such in
    // the picker. Preview-tagged ids surface the "preview" warning instead.
    assert.strictEqual(provider.getModelPickerInfo('gpt-3.5-turbo').warning, 'deprecated');
    assert.strictEqual(provider.getModelPickerInfo('gpt-4-turbo').warning, 'deprecated');
    assert.strictEqual(
      provider.getModelPickerInfo('o1-preview').warning,
      'preview',
    );
  });

  it('reports modelTier and capability flags from getCapabilities', () => {
    const provider = new OpenAIProvider({ token: 'test-token', host: 'http://unused' });
    assert.strictEqual(provider.getCapabilities('gpt-5').modelTier, 'strong');
    assert.strictEqual(provider.getCapabilities('gpt-4o-mini').modelTier, 'medium');
    assert.strictEqual(provider.getCapabilities('gpt-3.5-turbo').modelTier, 'weak');
    assert.strictEqual(provider.getCapabilities('o4-mini').toolSupport, 'native');
    // o-series reasoning models don't do parallel tool calls; gpt-4o does.
    assert.strictEqual(provider.getCapabilities('o3').parallelToolCalls, false);
    assert.strictEqual(provider.getCapabilities('gpt-4o').parallelToolCalls, true);
    // o1-mini / o1-preview are tool-disabled per OpenAI's docs.
    assert.strictEqual(provider.getCapabilities('o1-mini').toolSupport, 'none');
  });

  it('strips temperature for reasoning models so the API does not 400', async () => {
    await withServer(
      (req, res) => {
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [] }));
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          assert.strictEqual(parsed.model, 'o4-mini');
          assert.strictEqual(parsed.stream, false);
          // Reasoning models must not receive temperature.
          assert.ok(!('temperature' in parsed));
          // o-series doesn't support parallel tool calls.
          assert.ok(!('parallel_tool_calls' in parsed));
          assert.strictEqual(parsed.max_completion_tokens, 1024);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: 'thought through it.' } }],
              usage: { prompt_tokens: 4, completion_tokens: 7, total_tokens: 11 },
            }),
          );
        });
      },
      async baseUrl => {
        const provider = new OpenAIProvider({ token: 'test-token', host: baseUrl });
        const result = await provider.chatNoStream(
          'o4-mini',
          [{ role: 'user', content: 'think' }],
          undefined,
          { maxTokens: 1024, temperature: 0 },
        );
        assert.strictEqual(result.content, 'thought through it.');
        assert.deepStrictEqual(result.usage, {
          promptTokens: 4,
          completionTokens: 7,
          totalTokens: 11,
        });
      },
    );
  });

  it('keeps temperature on non-reasoning chat models', async () => {
    await withServer(
      (req, res) => {
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [] }));
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          assert.strictEqual(parsed.model, 'gpt-4o');
          assert.strictEqual(parsed.temperature, 0.4);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: 'ok' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
        });
      },
      async baseUrl => {
        const provider = new OpenAIProvider({ token: 'test-token', host: baseUrl });
        const result = await provider.chatNoStream(
          'gpt-4o',
          [{ role: 'user', content: 'hi' }],
          undefined,
          { maxTokens: 16, temperature: 0.4 },
        );
        assert.strictEqual(result.content, 'ok');
      },
    );
  });
});
