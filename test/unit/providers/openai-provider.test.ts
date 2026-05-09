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
              // These should all be filtered out by filterChatModels:
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
    assert.strictEqual(provider.getModelPickerInfo('o1-preview').warning, 'preview');
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

  it('routes gpt-5-codex through /v1/responses with the new body shape', async () => {
    await withServer(
      (req, res) => {
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [] }));
          return;
        }

        // Codex must hit the Responses endpoint, not chat/completions —
        // the latter returns 404 "not a chat model" upstream.
        assert.strictEqual(req.url, '/v1/responses');

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          assert.strictEqual(parsed.model, 'gpt-5-codex');
          // Responses-API shape: input/instructions, not messages.
          assert.ok(Array.isArray(parsed.input));
          assert.strictEqual('messages' in parsed, false);
          // Tools flatten to `{type, name, description, parameters, strict}`.
          assert.strictEqual(parsed.tools[0].type, 'function');
          assert.strictEqual(parsed.tools[0].name, 'Read');
          assert.strictEqual('function' in parsed.tools[0], false);
          // Codex rejects temperature even via the Responses path.
          assert.strictEqual('temperature' in parsed, false);
          // max_output_tokens, not max_completion_tokens.
          assert.strictEqual(parsed.max_output_tokens, 1024);
          assert.strictEqual(parsed.store, false);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'resp_test',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'codex thought it through.' }],
                },
              ],
              usage: {
                input_tokens: 4,
                output_tokens: 7,
                total_tokens: 11,
                output_tokens_details: { reasoning_tokens: 5 },
              },
            }),
          );
        });
      },
      async baseUrl => {
        const provider = new OpenAIProvider({ token: 'test-token', host: baseUrl });
        const result = await provider.chatNoStream(
          'gpt-5-codex',
          [
            { role: 'system', content: 'be helpful' },
            { role: 'user', content: 'think' },
          ],
          [
            {
              type: 'function',
              function: { name: 'Read', description: 'read', parameters: {} },
            },
          ],
          { maxTokens: 1024, temperature: 0 },
        );
        assert.strictEqual(result.content, 'codex thought it through.');
        assert.deepStrictEqual(result.usage, {
          promptTokens: 4,
          completionTokens: 7,
          totalTokens: 11,
          reasoningTokens: 5,
        });
      },
    );
  });

  it('routes dotted-minor codex variants (gpt-5.3-codex, gpt-5.1-codex-mini) through /v1/responses', async () => {
    const seen: string[] = [];
    await withServer(
      (req, res) => {
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [] }));
          return;
        }
        seen.push(req.url ?? '');
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'ok' }],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            }),
          );
        });
      },
      async baseUrl => {
        const provider = new OpenAIProvider({ token: 'test-token', host: baseUrl });
        await provider.chatNoStream('gpt-5.3-codex', [{ role: 'user', content: 'hi' }]);
        await provider.chatNoStream('gpt-5.1-codex-mini', [{ role: 'user', content: 'hi' }]);
        assert.deepStrictEqual(seen, ['/v1/responses', '/v1/responses']);
      },
    );
  });

  it('still routes gpt-5 (non-codex) through /v1/chat/completions', async () => {
    await withServer(
      (req, res) => {
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [] }));
          return;
        }

        assert.strictEqual(req.url, '/v1/chat/completions');

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          assert.strictEqual(parsed.model, 'gpt-5');
          // Chat-completions shape: messages, not input.
          assert.ok(Array.isArray(parsed.messages));
          assert.strictEqual('input' in parsed, false);

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
          'gpt-5',
          [{ role: 'user', content: 'hi' }],
          undefined,
          { maxTokens: 16 },
        );
        assert.strictEqual(result.content, 'ok');
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
