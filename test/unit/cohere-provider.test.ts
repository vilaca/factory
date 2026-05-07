import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { CohereProvider } from '../../src/providers/cohere.js';

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

describe('CohereProvider', () => {
  it('lists chat models from /v1/models using bearer auth', async () => {
    await withServer(
      (req, res) => {
        assert.strictEqual(req.method, 'GET');
        assert.strictEqual(req.url, '/v1/models?endpoint=chat&page_size=1000');
        assert.strictEqual(req.headers.authorization, 'Bearer test-token');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: [
              { name: 'command-a-03-2025', endpoints: ['chat'], context_length: 256000 },
              { name: 'command-r7b-12-2024', endpoints: ['chat'], context_length: 128000 },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new CohereProvider({ token: 'test-token', host: baseUrl });
        const models = await provider.listModels();
        assert.deepStrictEqual(models, ['command-a-03-2025', 'command-r7b-12-2024']);
      },
    );
  });

  it('builds picker details and warnings from model ids', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: [
              { name: 'command-a-03-2025', endpoints: ['chat'], context_length: 256000 },
              { name: 'command-r-plus-preview', endpoints: ['chat'], context_length: 128000 },
              {
                name: 'command-r7b-12-2024',
                endpoints: ['chat'],
                context_length: 128000,
                is_deprecated: true,
              },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new CohereProvider({ token: 'test-token', host: baseUrl });
        await provider.listModels();

        assert.deepStrictEqual(provider.getModelPickerInfo('command-a-03-2025'), {
          label: 'command-a-03-2025',
          detail: 'text-only · tools · reasoning · max 8.2k out · 256k ctx',
          warning: undefined,
        });
        assert.deepStrictEqual(provider.getModelPickerInfo('command-r-plus-preview'), {
          label: 'command-r-plus-preview',
          detail: 'text-only · tools · reasoning · max 8.2k out · 128k ctx',
          warning: 'preview',
        });
        assert.deepStrictEqual(provider.getModelPickerInfo('command-r7b-12-2024'), {
          label: 'command-r7b-12-2024',
          detail: 'text-only · tools · reasoning · max 8.2k out · 128k ctx',
          warning: 'deprecated',
        });
      },
    );
  });

  it('sends Cohere chat payloads and parses tool calls', async () => {
    await withServer(
      (req, res) => {
        if (req.url === '/v1/models?endpoint=chat&page_size=1000') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ models: [] }));
          return;
        }

        assert.strictEqual(req.method, 'POST');
        assert.strictEqual(req.url, '/v2/chat');
        assert.strictEqual(req.headers.authorization, 'Bearer test-token');

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          assert.strictEqual(parsed.model, 'command-a-03-2025');
          assert.strictEqual(parsed.stream, false);
          assert.strictEqual(parsed.max_tokens, 2048);
          assert.strictEqual(parsed.tools[0].function.name, 'Read');
          assert.strictEqual(parsed.messages[0].content, 'inspect the repo');
          assert.strictEqual(parsed.messages[1].tool_plan, 'I will read the file.');
          assert.strictEqual(
            parsed.messages[1].tool_calls[0].function.arguments,
            '{"file_path":"README.md"}',
          );
          assert.strictEqual(parsed.messages[2].role, 'tool');
          assert.strictEqual(parsed.messages[2].tool_call_id, 'call_1');
          assert.strictEqual(parsed.messages[2].content, 'file contents');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'resp_1',
              finish_reason: 'TOOL_CALL',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Checking that file.' }],
                tool_calls: [
                  {
                    id: 'call_2',
                    type: 'function',
                    function: {
                      name: 'Read',
                      arguments: '{"file_path":"package.json"}',
                    },
                  },
                ],
              },
              meta: {
                tokens: {
                  input_tokens: 9,
                  output_tokens: 5,
                },
              },
            }),
          );
        });
      },
      async baseUrl => {
        const provider = new CohereProvider({ token: 'test-token', host: baseUrl });
        const result = await provider.chatNoStream(
          'command-a-03-2025',
          [
            { role: 'user', content: 'inspect the repo' },
            {
              role: 'assistant',
              content: 'I will read the file.',
              tool_calls: [
                { id: 'call_1', function: { name: 'Read', arguments: { file_path: 'README.md' } } },
              ],
            },
            { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
          ],
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
        assert.strictEqual(result.doneReason, 'tool_call');
        assert.deepStrictEqual(result.tool_calls, [
          {
            id: 'call_2',
            function: {
              name: 'Read',
              arguments: { file_path: 'package.json' },
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
