import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { WorkersAiProvider } from '../../src/providers/workersai.js';

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
        await fn(`http://127.0.0.1:${address.port}/client/v4/accounts/test-account/ai/v1`);
        server.close((err) => err ? reject(err) : resolve());
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

describe('WorkersAiProvider', () => {
  it('lists text-generation models from model search using bearer auth', async () => {
    await withServer((req, res) => {
      assert.strictEqual(req.method, 'GET');
      assert.strictEqual(req.url, '/client/v4/accounts/test-account/ai/models/search?page=1&per_page=100&hide_experimental=false');
      assert.strictEqual(req.headers.authorization, 'Bearer test-token');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        result: [
          { name: '@cf/qwen/qwen2.5-coder-32b-instruct', task: { name: 'Text Generation' }, description: 'coder' },
          { name: '@cf/meta/llama-4-scout-17b-16e-instruct', task: { name: 'Text Generation' }, description: 'vision' },
          { name: '@cf/openai/whisper', task: { name: 'Automatic Speech Recognition' }, description: 'asr' },
        ],
      }));
    }, async (baseUrl) => {
      const provider = new WorkersAiProvider({ token: 'test-token', host: baseUrl });
      const models = await provider.listModels();
      assert.deepStrictEqual(models, [
        '@cf/qwen/qwen2.5-coder-32b-instruct',
        '@cf/meta/llama-4-scout-17b-16e-instruct',
      ]);
    });
  });

  it('builds picker details and warnings from model ids', async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        result: [
          { name: '@cf/openai/gpt-oss-120b', task: { name: 'Text Generation' }, supports_function: true, supports_reasoning: true, context_window: 128000 },
          { name: '@cf/meta/llama-4-scout-17b-16e-instruct', task: { name: 'Text Generation' }, supports_function: true, supports_vision: true, context_window: 131000, experimental: true },
          { name: '@cf/qwen/qwen2.5-coder-32b-instruct', task: { name: 'Text Generation' }, context_window: 32768 },
        ],
      }));
    }, async (baseUrl) => {
      const provider = new WorkersAiProvider({ token: 'test-token', host: baseUrl });
      await provider.listModels();

      assert.deepStrictEqual(provider.getModelPickerInfo('@cf/openai/gpt-oss-120b'), {
        label: '@cf/openai/gpt-oss-120b',
        detail: 'text-only · tools · reasoning · max 65.5k out · 128k ctx',
        warning: undefined,
      });
      assert.deepStrictEqual(provider.getModelPickerInfo('@cf/meta/llama-4-scout-17b-16e-instruct'), {
        label: '@cf/meta/llama-4-scout-17b-16e-instruct',
        detail: 'vision · tools · max 8.2k out · 131k ctx',
        warning: 'preview',
      });
      assert.deepStrictEqual(provider.getModelPickerInfo('@cf/qwen/qwen2.5-coder-32b-instruct'), {
        label: '@cf/qwen/qwen2.5-coder-32b-instruct',
        detail: 'text-only · tools · max 8.2k out · 32.8k ctx',
        warning: undefined,
      });
    });
  });

  it('sends OpenAI-compatible chat payloads and parses tool calls', async () => {
    await withServer((req, res) => {
      if (req.url?.startsWith('/client/v4/accounts/test-account/ai/models/search')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result: [] }));
        return;
      }

      assert.strictEqual(req.method, 'POST');
      assert.strictEqual(req.url, '/client/v4/accounts/test-account/ai/v1/chat/completions');
      assert.strictEqual(req.headers.authorization, 'Bearer test-token');

      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        assert.strictEqual(parsed.model, '@cf/qwen/qwen2.5-coder-32b-instruct');
        assert.strictEqual(parsed.stream, false);
        assert.strictEqual(parsed.parallel_tool_calls, true);
        assert.strictEqual(parsed.max_completion_tokens, 2048);
        assert.strictEqual(parsed.tools[0].function.name, 'Read');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
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
        }));
      });
    }, async (baseUrl) => {
      const provider = new WorkersAiProvider({ token: 'test-token', host: baseUrl });
      const result = await provider.chatNoStream(
        '@cf/qwen/qwen2.5-coder-32b-instruct',
        [{ role: 'user', content: 'inspect the repo' }],
        [{
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
        }],
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
    });
  });
});
