import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { CopilotProvider } from '../../src/providers/copilot.js';

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

describe('CopilotProvider', () => {
  it('can be constructed without an eager token', () => {
    const provider = new CopilotProvider();
    assert.strictEqual(provider.name, 'copilot');
  });

  it('lists models from /models using bearer auth', async () => {
    await withServer(
      (req, res) => {
        assert.strictEqual(req.method, 'GET');
        assert.strictEqual(req.url, '/models');
        assert.strictEqual(req.headers.authorization, 'Bearer test-token');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              {
                id: 'gpt-4.1',
                capabilities: { type: 'chat' },
                model_picker_enabled: true,
                policy: { state: 'enabled' },
              },
              {
                id: 'claude-sonnet-4',
                capabilities: { type: 'chat' },
                model_picker_enabled: true,
                policy: { state: 'enabled' },
              },
              {
                id: 'copilot/claude-opus-4.7',
                capabilities: { type: 'chat' },
                model_picker_enabled: false,
                policy: { state: 'enabled' },
              },
              {
                id: 'text-embedding-3-large',
                capabilities: { type: 'embeddings' },
                model_picker_enabled: true,
                policy: { state: 'enabled' },
              },
              {
                id: 'retired-model',
                capabilities: { type: 'chat' },
                model_picker_enabled: true,
                policy: { state: 'disabled' },
              },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new CopilotProvider({ token: 'test-token', host: baseUrl });
        const models = await provider.listModels();
        assert.deepStrictEqual(models, ['gpt-4.1', 'claude-sonnet-4']);
      },
    );
  });

  it('provides picker details for Copilot models', async () => {
    const provider = new CopilotProvider({ token: 'test-token' });
    assert.deepStrictEqual(provider.getModelPickerInfo('gpt-4.1'), {
      label: 'gpt-4.1',
      detail: 'tools · max 16.4k out',
    });
    assert.deepStrictEqual(provider.getModelPickerInfo('o4-mini'), {
      label: 'o4-mini',
      detail: 'tools · max 8.2k out',
    });
  });

  it('sends OpenAI-style chat payloads and parses tool calls', async () => {
    await withServer(
      (req, res) => {
        assert.strictEqual(req.method, 'POST');
        assert.strictEqual(req.url, '/chat/completions');
        assert.strictEqual(req.headers.authorization, 'Bearer test-token');

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          assert.strictEqual(parsed.model, 'gpt-4.1');
          assert.strictEqual(parsed.stream, false);
          assert.strictEqual(parsed.messages[0].role, 'user');
          assert.strictEqual(parsed.messages[0].content, 'inspect the repo');
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
        const provider = new CopilotProvider({ token: 'test-token', host: baseUrl });
        const result = await provider.chatNoStream(
          'gpt-4.1',
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

  it('coalesces sparse streamed tool call indices without yielding holes', async () => {
    await withServer(
      (req, res) => {
        assert.strictEqual(req.method, 'POST');
        assert.strictEqual(req.url, '/chat/completions');
        assert.strictEqual(req.headers.authorization, 'Bearer test-token');

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"Read","arguments":"{\\"file_path\\":\\"README.md\\"}"}}]}}]}\n\n',
        );
        res.write(
          'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}\n\n',
        );
        res.write('data: [DONE]\n\n');
        res.end();
      },
      async baseUrl => {
        const provider = new CopilotProvider({ token: 'test-token', host: baseUrl });
        const chunks = [];

        for await (const chunk of provider.chat(
          'gpt-4.1',
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
        )) {
          chunks.push(chunk);
        }

        const toolChunk = chunks.find(chunk => chunk.tool_calls);
        assert.ok(toolChunk);
        assert.deepStrictEqual(toolChunk.tool_calls, [
          {
            id: 'call_2',
            function: {
              name: 'Read',
              arguments: { file_path: 'README.md' },
            },
          },
        ]);
      },
    );
  });
});
