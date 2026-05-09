import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { CodestralProvider, MistralProvider } from '../../../src/providers/mistral.js';

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

describe('MistralProvider', () => {
  it('lists chat-capable models from the models endpoint', async () => {
    await withServer(
      (req, res) => {
        assert.strictEqual(req.method, 'GET');
        assert.strictEqual(req.url, '/v1/models');
        assert.strictEqual(req.headers.authorization, 'Bearer test-token');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              {
                id: 'mistral-small-latest',
                max_context_length: 128000,
                capabilities: { completion_chat: true, function_calling: true },
              },
              { id: 'mistral-ocr-2505', max_context_length: 32000 },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new MistralProvider({ token: 'test-token', host: baseUrl });
        const models = await provider.listModels();
        assert.deepStrictEqual(models, ['mistral-small-latest']);
      },
    );
  });

  it('builds picker details from model metadata', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              {
                id: 'magistral-medium-latest',
                max_context_length: 128000,
                capabilities: { completion_chat: true, function_calling: true },
              },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new MistralProvider({ token: 'test-token', host: baseUrl });
        await provider.listModels();
        assert.deepStrictEqual(provider.getModelPickerInfo('magistral-medium-latest'), {
          label: 'magistral-medium-latest',
          detail: 'text-only · tools · reasoning · max 32.8k out',
          warning: undefined,
        });
      },
    );
  });

  it('sends chat payloads and parses tool calls', async () => {
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
          assert.strictEqual(parsed.model, 'mistral-small-latest');
          assert.strictEqual(parsed.stream, false);
          assert.strictEqual(parsed.tool_choice, 'auto');
          assert.strictEqual(parsed.parallel_tool_calls, true);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: 'Inspecting now.',
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
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
              },
            }),
          );
        });
      },
      async baseUrl => {
        const provider = new MistralProvider({ token: 'test-token', host: baseUrl });
        const result = await provider.chatNoStream(
          'mistral-small-latest',
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

        assert.strictEqual(result.content, 'Inspecting now.');
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
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        });
      },
    );
  });

  it('uses the Codestral base URL and provider name', async () => {
    await withServer(
      (req, res) => {
        assert.strictEqual(req.method, 'GET');
        assert.strictEqual(req.url, '/v1/models');
        assert.strictEqual(req.headers.authorization, 'Bearer codestral-token');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              {
                id: 'codestral-latest',
                max_context_length: 256000,
                capabilities: { completion_chat: true, function_calling: true },
              },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new CodestralProvider({ token: 'codestral-token', host: baseUrl });
        assert.strictEqual(provider.name, 'codestral');
        const models = await provider.listModels();
        assert.deepStrictEqual(models, ['codestral-latest']);
      },
    );
  });

  it('falls back to a static catalog when Codestral models endpoint is unavailable', async () => {
    await withServer(
      (req, res) => {
        assert.strictEqual(req.method, 'GET');
        assert.strictEqual(req.url, '/v1/models');
        assert.strictEqual(req.headers.authorization, 'Bearer codestral-token');
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: 'no Route matched with those values',
          }),
        );
      },
      async baseUrl => {
        const provider = new CodestralProvider({ token: 'codestral-token', host: baseUrl });
        const models = await provider.listModels();
        assert.deepStrictEqual(models, ['codestral-latest']);
        assert.deepStrictEqual(provider.getModelPickerInfo('codestral-latest'), {
          label: 'codestral-latest',
          detail: 'text-only · tools · max 32.8k out',
          warning: undefined,
        });
      },
    );
  });
});
