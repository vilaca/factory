import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { GroqProvider } from '../../src/providers/groq.js';

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
        await fn(`http://127.0.0.1:${address.port}/openai/v1`);
        server.close(err => (err ? reject(err) : resolve()));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

describe('GroqProvider', () => {
  it('lists models from /models using bearer auth', async () => {
    await withServer(
      (req, res) => {
        assert.strictEqual(req.method, 'GET');
        assert.strictEqual(req.url, '/openai/v1/models');
        assert.strictEqual(req.headers.authorization, 'Bearer test-token');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              { id: 'llama-3.3-70b-versatile', object: 'model', owned_by: 'groq' },
              { id: 'whisper-large-v3', object: 'model', owned_by: 'groq' },
              { id: 'groq/compound-mini', object: 'model', owned_by: 'groq' },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new GroqProvider({ token: 'test-token', host: baseUrl });
        const models = await provider.listModels();
        assert.deepStrictEqual(models, ['llama-3.3-70b-versatile', 'groq/compound-mini']);
      },
    );
  });

  it('builds picker details and warnings from model ids', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              { id: 'openai/gpt-oss-120b', object: 'model', owned_by: 'groq' },
              {
                id: 'meta-llama/llama-4-scout-17b-16e-instruct',
                object: 'model',
                owned_by: 'groq',
              },
              { id: 'groq/compound-mini', object: 'model', owned_by: 'groq' },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new GroqProvider({ token: 'test-token', host: baseUrl });
        await provider.listModels();

        assert.deepStrictEqual(provider.getModelPickerInfo('openai/gpt-oss-120b'), {
          label: 'openai/gpt-oss-120b',
          detail: 'text-only · tools · reasoning · max 65.5k out · 131.1k ctx',
          warning: undefined,
        });
        assert.deepStrictEqual(
          provider.getModelPickerInfo('meta-llama/llama-4-scout-17b-16e-instruct'),
          {
            label: 'meta-llama/llama-4-scout-17b-16e-instruct',
            detail: 'vision · tools · max 8.2k out · 131.1k ctx',
            warning: 'preview',
          },
        );
        assert.deepStrictEqual(provider.getModelPickerInfo('groq/compound-mini'), {
          label: 'groq/compound-mini',
          detail: 'text-only · no tools · reasoning · max 8.2k out · 131.1k ctx',
          warning: undefined,
        });
      },
    );
  });

  it('sends Groq chat payloads and parses tool calls', async () => {
    await withServer(
      (req, res) => {
        if (req.url === '/openai/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [] }));
          return;
        }

        assert.strictEqual(req.method, 'POST');
        assert.strictEqual(req.url, '/openai/v1/chat/completions');
        assert.strictEqual(req.headers.authorization, 'Bearer test-token');

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          assert.strictEqual(parsed.model, 'openai/gpt-oss-120b');
          assert.strictEqual(parsed.stream, false);
          assert.strictEqual(parsed.parallel_tool_calls, false);
          assert.strictEqual(parsed.max_completion_tokens, 2048);
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
        const provider = new GroqProvider({ token: 'test-token', host: baseUrl });
        const result = await provider.chatNoStream(
          'openai/gpt-oss-120b',
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
          { maxTokens: 2048 },
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
});
