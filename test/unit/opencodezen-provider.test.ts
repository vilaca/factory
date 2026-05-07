import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { OpenCodeZenProvider } from '../../src/providers/opencodezen.js';

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
        await fn(`http://127.0.0.1:${address.port}/zen/v1`);
        server.close(err => (err ? reject(err) : resolve()));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

describe('OpenCodeZenProvider', () => {
  it('lists every Zen model route except unsupported /responses models', async () => {
    await withServer(
      (req, res) => {
        assert.strictEqual(req.method, 'GET');
        assert.strictEqual(req.url, '/zen/v1/models');
        assert.strictEqual(req.headers.authorization, undefined);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              { id: 'qwen3.6-plus', object: 'model', owned_by: 'opencode' },
              { id: 'gpt-5.4', object: 'model', owned_by: 'opencode' },
              { id: 'claude-sonnet-4-6', object: 'model', owned_by: 'opencode' },
              { id: 'gemini-3-flash', object: 'model', owned_by: 'opencode' },
              { id: 'minimax-m2.5-free', object: 'model', owned_by: 'opencode' },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new OpenCodeZenProvider({ host: baseUrl });
        const models = await provider.listModels();
        assert.deepStrictEqual(models, [
          'qwen3.6-plus',
          'claude-sonnet-4-6',
          'gemini-3-flash',
          'minimax-m2.5-free',
        ]);
      },
    );
  });

  it('builds picker details from model name heuristics', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              { id: 'qwen3.6-plus', object: 'model', owned_by: 'opencode' },
              { id: 'hy3-preview-free', object: 'model', owned_by: 'opencode' },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new OpenCodeZenProvider({ token: 'test-token', host: baseUrl });
        await provider.listModels();

        assert.deepStrictEqual(provider.getModelPickerInfo('qwen3.6-plus'), {
          label: 'qwen3.6-plus',
          detail: 'paid · text-only · tools · reasoning · max 65.5k out · 262.1k ctx',
          warning: undefined,
        });
        assert.deepStrictEqual(provider.getModelPickerInfo('hy3-preview-free'), {
          label: 'hy3-preview-free',
          detail: 'free · vision · tools · max 8.2k out · 128k ctx',
          warning: 'preview',
        });
      },
    );
  });

  it('sends OpenAI-style chat payloads and parses tool calls', async () => {
    await withServer(
      (req, res) => {
        if (req.url === '/zen/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [] }));
          return;
        }

        assert.strictEqual(req.method, 'POST');
        assert.strictEqual(req.url, '/zen/v1/chat/completions');
        assert.strictEqual(req.headers.authorization, 'Bearer test-token');

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          assert.strictEqual(parsed.model, 'qwen3.6-plus');
          assert.strictEqual(parsed.stream, false);
          assert.strictEqual(parsed.parallel_tool_calls, true);
          assert.strictEqual(parsed.tools[0].function.name, 'Read');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: 'Inspecting that file.',
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
                completion_tokens: 4,
                total_tokens: 14,
              },
            }),
          );
        });
      },
      async baseUrl => {
        const provider = new OpenCodeZenProvider({ token: 'test-token', host: baseUrl });
        const result = await provider.chatNoStream(
          'qwen3.6-plus',
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

        assert.strictEqual(result.content, 'Inspecting that file.');
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
          completionTokens: 4,
          totalTokens: 14,
        });
      },
    );
  });

  it('routes Claude models through the Anthropic messages API', async () => {
    await withServer(
      (req, res) => {
        assert.strictEqual(req.method, 'POST');
        assert.strictEqual(req.url, '/zen/v1/messages');
        assert.strictEqual(req.headers['x-api-key'], 'test-token');
        assert.strictEqual(req.headers['anthropic-version'], '2023-06-01');

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          assert.strictEqual(parsed.model, 'claude-sonnet-4-6');
          assert.strictEqual(parsed.messages[0].role, 'user');
          assert.strictEqual(parsed.tools[0].name, 'Read');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              content: [
                { type: 'text', text: 'Inspecting that file.' },
                {
                  type: 'tool_use',
                  id: 'toolu_1',
                  name: 'Read',
                  input: { file_path: 'README.md' },
                },
              ],
              usage: {
                input_tokens: 10,
                output_tokens: 4,
              },
            }),
          );
        });
      },
      async baseUrl => {
        const provider = new OpenCodeZenProvider({ token: 'test-token', host: baseUrl });
        const result = await provider.chatNoStream(
          'claude-sonnet-4-6',
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

        assert.strictEqual(result.content, 'Inspecting that file.');
        assert.deepStrictEqual(result.tool_calls, [
          {
            id: 'toolu_1',
            function: {
              name: 'Read',
              arguments: { file_path: 'README.md' },
            },
          },
        ]);
        assert.deepStrictEqual(result.usage, {
          promptTokens: 10,
          completionTokens: 4,
          totalTokens: 14,
        });
      },
    );
  });

  it('routes Gemini models through the Google native generateContent API', async () => {
    await withServer(
      (req, res) => {
        assert.strictEqual(req.method, 'POST');
        assert.strictEqual(req.url, '/zen/v1/models/gemini-3-flash:generateContent');
        assert.strictEqual(req.headers['x-goog-api-key'], 'test-token');

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          assert.strictEqual(parsed.contents[0].role, 'user');
          assert.strictEqual(parsed.contents[0].parts[0].text, 'inspect the repo');
          assert.strictEqual(parsed.tools[0].functionDeclarations[0].name, 'Read');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      { text: 'Inspecting that file.' },
                      {
                        functionCall: {
                          name: 'Read',
                          args: { file_path: 'README.md' },
                        },
                      },
                    ],
                  },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 4,
                totalTokenCount: 14,
              },
            }),
          );
        });
      },
      async baseUrl => {
        const provider = new OpenCodeZenProvider({ token: 'test-token', host: baseUrl });
        const result = await provider.chatNoStream(
          'gemini-3-flash',
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

        assert.strictEqual(result.content, 'Inspecting that file.');
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
          completionTokens: 4,
          totalTokens: 14,
        });
      },
    );
  });
});
