import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { VercelProvider } from '../../../src/providers/vercel.js';

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

describe('VercelProvider', () => {
  it('lists language models from /models without requiring auth', async () => {
    await withServer(
      (req, res) => {
        assert.strictEqual(req.method, 'GET');
        assert.strictEqual(req.url, '/v1/models');
        assert.strictEqual(req.headers.authorization, undefined);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              {
                id: 'openai/gpt-5.4',
                type: 'language',
                context_window: 400000,
                max_tokens: 128000,
                tags: ['tool-use', 'reasoning'],
              },
              {
                id: 'openai/text-embedding-3-large',
                type: 'embedding',
              },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new VercelProvider({ host: baseUrl });
        const models = await provider.listModels();
        assert.deepStrictEqual(models, ['openai/gpt-5.4']);
      },
    );
  });

  it('builds picker details and warnings from model metadata', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              {
                id: 'openai/gpt-5.4',
                type: 'language',
                context_window: 400000,
                max_tokens: 128000,
                tags: ['tool-use', 'reasoning'],
              },
              {
                id: 'alibaba/qwen-3.6-max-preview',
                name: 'Qwen 3.6 Max Preview',
                type: 'language',
                context_window: 240000,
                max_tokens: 64000,
                tags: ['vision', 'tool-use', 'reasoning', 'file-input'],
              },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new VercelProvider({ token: 'test-token', host: baseUrl });
        await provider.listModels();

        assert.deepStrictEqual(provider.getModelPickerInfo('openai/gpt-5.4'), {
          label: 'openai/gpt-5.4',
          detail: 'text-only · tools · reasoning · max 128k out · 400k ctx',
          warning: undefined,
        });
        assert.deepStrictEqual(provider.getModelPickerInfo('alibaba/qwen-3.6-max-preview'), {
          label: 'alibaba/qwen-3.6-max-preview',
          detail: 'vision · tools · reasoning · file input · max 64k out · 240k ctx',
          warning: 'preview',
        });
      },
    );
  });

  it('reports tool support from capability tags', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              {
                id: 'openai/gpt-5.4',
                type: 'language',
                tags: ['tool-use', 'reasoning'],
              },
              {
                id: 'openai/gpt-image-1',
                type: 'language',
                tags: ['vision'],
              },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new VercelProvider({ token: 'test-token', host: baseUrl });
        assert.deepStrictEqual(await provider.getModelInfo('openai/gpt-5.4'), {
          supportsTools: true,
          capabilities: ['tool-use', 'reasoning'],
        });
        assert.deepStrictEqual(await provider.getModelInfo('openai/gpt-image-1'), {
          supportsTools: false,
          capabilities: ['vision'],
        });
      },
    );
  });

  it('sends OpenAI-style chat payloads and parses tool calls', async () => {
    await withServer(
      (req, res) => {
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [] }));
          return;
        }

        assert.strictEqual(req.method, 'POST');
        assert.strictEqual(req.url, '/v1/chat/completions');
        assert.strictEqual(req.headers.authorization, 'Bearer test-token');

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          assert.strictEqual(parsed.model, 'openai/gpt-5.4');
          assert.strictEqual(parsed.stream, false);
          assert.strictEqual(parsed.parallel_tool_calls, true);
          assert.strictEqual(parsed.tools[0].function.name, 'Read');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: 'Checking that file.',
                    tool_calls: [
                      {
                        id: 'call_1',
                        function: {
                          name: 'Read',
                          arguments: '{"file_path":"README.md"}',
                        },
                      },
                    ],
                  },
                },
              ],
              usage: {
                prompt_tokens: 9,
                completion_tokens: 5,
                total_tokens: 14,
              },
            }),
          );
        });
      },
      async baseUrl => {
        const provider = new VercelProvider({ token: 'test-token', host: baseUrl });
        const result = await provider.chatNoStream(
          'openai/gpt-5.4',
          [{ role: 'user', content: 'inspect the repo' }],
          [
            {
              type: 'function',
              function: {
                name: 'Read',
                description: 'Read a file',
                parameters: {
                  type: 'object',
                  properties: {
                    file_path: { type: 'string' },
                  },
                  required: ['file_path'],
                },
              },
            },
          ],
        );

        assert.strictEqual(result.content, 'Checking that file.');
        assert.deepStrictEqual(result.tool_calls, [
          {
            id: 'call_1',
            function: {
              name: 'Read',
              arguments: { file_path: 'README.md' },
            },
          },
        ]);
        assert.deepStrictEqual(result.usage, {
          promptTokens: 9,
          completionTokens: 5,
          totalTokens: 14,
        });
      },
    );
  });

  it('adds an auth hint to 401 errors', async () => {
    await withServer(
      (req, res) => {
        assert.strictEqual(req.method, 'POST');
        assert.strictEqual(req.url, '/v1/chat/completions');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
      },
      async baseUrl => {
        const provider = new VercelProvider({ token: 'bad-token', host: baseUrl });
        await assert.rejects(
          () => provider.chatNoStream('openai/gpt-5.4', [{ role: 'user', content: 'hello' }]),
          (err: Error) =>
            err.message.includes('Vercel AI Gateway API error 401') &&
            err.message.includes('AI_GATEWAY_API_KEY') &&
            err.message.includes('vercelToken/token'),
        );
      },
    );
  });
});
