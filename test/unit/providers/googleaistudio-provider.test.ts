import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { GoogleAiStudioProvider } from '../../../src/providers/googleaistudio/index.js';

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
        await fn(`http://127.0.0.1:${address.port}/v1beta/openai`);
        server.close(err => (err ? reject(err) : resolve()));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

describe('GoogleAiStudioProvider', () => {
  it('lists supported models from the native models endpoint', async () => {
    await withServer(
      (req, res) => {
        assert.strictEqual(req.method, 'GET');
        assert.ok(req.url?.startsWith('/v1beta/models?pageSize=1000'));
        assert.strictEqual(req.headers['x-goog-api-key'], 'test-token');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-2.5-pro',
                displayName: 'Gemini 2.5 Pro',
                description: 'Reasoning model for text, code, images, audio, and video inputs.',
                inputTokenLimit: 1048576,
                outputTokenLimit: 65536,
                supportedGenerationMethods: ['generateContent'],
                thinking: true,
              },
              {
                name: 'models/gemini-embedding-001',
                baseModelId: 'gemini-embedding-001',
                displayName: 'Gemini Embedding',
                supportedGenerationMethods: ['embedContent'],
              },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new GoogleAiStudioProvider({ token: 'test-token', host: baseUrl });
        const models = await provider.listModels();
        assert.deepStrictEqual(models, ['gemini-2.5-pro']);
      },
    );
  });

  it('builds picker details from model metadata', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-2.5-pro-preview',
                baseModelId: 'gemini-2.5-pro-preview',
                displayName: 'Gemini 2.5 Pro Preview',
                inputTokenLimit: 1048576,
                outputTokenLimit: 65536,
                supportedGenerationMethods: ['generateContent'],
                thinking: true,
              },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new GoogleAiStudioProvider({ token: 'test-token', host: baseUrl });
        await provider.listModels();
        assert.deepStrictEqual(provider.getModelPickerInfo('gemini-2.5-pro-preview'), {
          label: 'gemini-2.5-pro-preview',
          detail: 'tools · reasoning · max 65.5k out · 1M ctx',
          warning: 'preview',
        });
      },
    );
  });

  it('derives the model id from name when baseModelId is missing', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-2.5-flash',
                displayName: 'Gemini 2.5 Flash',
                inputTokenLimit: 1048576,
                outputTokenLimit: 65536,
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new GoogleAiStudioProvider({ token: 'test-token', host: baseUrl });
        const models = await provider.listModels();
        assert.deepStrictEqual(models, ['gemini-2.5-flash']);
      },
    );
  });

  it('shows legacy 2.0 text models with a warning', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-2.0-flash',
                supportedGenerationMethods: ['generateContent'],
              },
              {
                name: 'models/gemini-2.5-flash',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new GoogleAiStudioProvider({ token: 'test-token', host: baseUrl });
        const models = await provider.listModels();
        assert.deepStrictEqual(models, ['gemini-2.0-flash', 'gemini-2.5-flash']);
        assert.deepStrictEqual(provider.getModelPickerInfo('gemini-2.0-flash'), {
          label: 'gemini-2.0-flash (legacy)',
          detail: 'tools · max 65.5k out · 1M ctx',
          warning: 'legacy - no longer available to new users',
        });
      },
    );
  });

  it('sends OpenAI-style chat payloads and parses tool calls', async () => {
    await withServer(
      (req, res) => {
        if (req.url?.startsWith('/v1beta/models')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ models: [] }));
          return;
        }

        assert.strictEqual(req.method, 'POST');
        assert.strictEqual(req.url, '/v1beta/openai/chat/completions');
        assert.strictEqual(req.headers.authorization, 'Bearer test-token');

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          assert.strictEqual(parsed.model, 'gemini-2.5-pro');
          assert.strictEqual(parsed.stream, false);
          assert.strictEqual(parsed.tool_choice, 'auto');
          assert.strictEqual(parsed.tools[0].function.name, 'Read');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: 'I will inspect that file.',
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
                prompt_tokens: 11,
                completion_tokens: 7,
                total_tokens: 18,
              },
            }),
          );
        });
      },
      async baseUrl => {
        const provider = new GoogleAiStudioProvider({ token: 'test-token', host: baseUrl });
        const result = await provider.chatNoStream(
          'gemini-2.5-pro',
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

        assert.strictEqual(result.content, 'I will inspect that file.');
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
          promptTokens: 11,
          completionTokens: 7,
          totalTokens: 18,
        });
      },
    );
  });
});
