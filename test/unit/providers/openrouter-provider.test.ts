import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { OpenRouterProvider, routesToAnthropic } from '../../../src/providers/openrouter.js';

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

describe('OpenRouterProvider', () => {
  it('lists chat models from /models using bearer auth', async () => {
    await withServer(
      (req, res) => {
        assert.strictEqual(req.method, 'GET');
        assert.strictEqual(req.url, '/models');
        assert.strictEqual(req.headers.authorization, 'Bearer test-token');
        assert.strictEqual(req.headers['x-openrouter-title'], 'factory');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              {
                id: 'openai/gpt-4.1',
                architecture: {
                  modality: 'text->text',
                  input_modalities: ['text'],
                  output_modalities: ['text'],
                },
                supported_parameters: ['tools', 'temperature'],
              },
              {
                id: 'openai/text-embedding-3-large',
                architecture: {
                  modality: 'text->embedding',
                  input_modalities: ['text'],
                  output_modalities: ['embedding'],
                },
              },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new OpenRouterProvider({ token: 'test-token', host: baseUrl });
        const models = await provider.listModels();
        assert.deepStrictEqual(models, ['openai/gpt-4.1']);
      },
    );
  });

  it('reports tool support from model metadata', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              {
                id: 'openai/gpt-4.1',
                architecture: {
                  modality: 'text->text',
                  input_modalities: ['text'],
                  output_modalities: ['text'],
                },
                supported_parameters: ['tools', 'temperature'],
              },
              {
                id: 'meta-llama/llama-3.3-70b-instruct',
                architecture: {
                  modality: 'text->text',
                  input_modalities: ['text'],
                  output_modalities: ['text'],
                },
                supported_parameters: ['temperature'],
              },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new OpenRouterProvider({ token: 'test-token', host: baseUrl });
        assert.deepStrictEqual(await provider.getModelInfo('openai/gpt-4.1'), {
          supportsTools: true,
          capabilities: ['tools', 'temperature'],
        });
        assert.deepStrictEqual(await provider.getModelInfo('meta-llama/llama-3.3-70b-instruct'), {
          supportsTools: false,
          capabilities: ['temperature'],
        });
      },
    );
  });

  it('appends (free) to free model display names', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              {
                id: 'openai/gpt-4.1:free',
                architecture: {
                  modality: 'text->text',
                  input_modalities: ['text'],
                  output_modalities: ['text'],
                },
                pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
              },
              {
                id: 'anthropic/claude-sonnet-4',
                architecture: {
                  modality: 'text->text',
                  input_modalities: ['text'],
                  output_modalities: ['text'],
                },
                pricing: { prompt: '0.000003', completion: '0.000015' },
              },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new OpenRouterProvider({ token: 'test-token', host: baseUrl });
        await provider.listModels();

        assert.strictEqual(
          provider.getDisplayModelName('openai/gpt-4.1:free'),
          'openai/gpt-4.1 (free)',
        );
        assert.strictEqual(
          provider.getDisplayModelName('anthropic/claude-sonnet-4'),
          'anthropic/claude-sonnet-4',
        );
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
                id: 'openai/gpt-4.1:free',
                architecture: {
                  modality: 'text+image->text',
                  input_modalities: ['text', 'image'],
                  output_modalities: ['text'],
                },
                supported_parameters: ['reasoning', 'structured_outputs', 'tools'],
                top_provider: { max_completion_tokens: 65536 },
                per_request_limits: {
                  free: {
                    tokens_per_minute: 40000,
                    requests_per_day: 200,
                    requests_per_minute: 10,
                  },
                },
                pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
              },
              {
                id: 'anthropic/claude-sonnet-4',
                architecture: {
                  modality: 'text->text',
                  input_modalities: ['text'],
                  output_modalities: ['text'],
                },
                top_provider: { max_completion_tokens: 8192 },
                pricing: { prompt: '0.000003', completion: '0.000015' },
                expiration_date: '2099-01-01T00:00:00.000Z',
              },
            ],
          }),
        );
      },
      async baseUrl => {
        const provider = new OpenRouterProvider({ token: 'test-token', host: baseUrl });
        await provider.listModels();

        assert.deepStrictEqual(provider.getModelPickerInfo('openai/gpt-4.1:free'), {
          label: 'openai/gpt-4.1 (free)',
          detail:
            'vision · tools · reasoning · structured output · max 65.5k out · free 40k TPM · free 200 RPD · free 10 RPM',
          warning: undefined,
        });
        assert.deepStrictEqual(provider.getModelPickerInfo('anthropic/claude-sonnet-4'), {
          label: 'anthropic/claude-sonnet-4',
          detail: 'text-only · no tools · max 8.2k out',
          warning: 'credits required',
        });
      },
    );
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
          assert.strictEqual(parsed.model, 'openai/gpt-4.1');
          assert.strictEqual(parsed.stream, false);
          assert.strictEqual(parsed.parallel_tool_calls, true);
          assert.strictEqual(parsed.messages[0].role, 'user');
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
        const provider = new OpenRouterProvider({ token: 'test-token', host: baseUrl });
        const result = await provider.chatNoStream(
          'openai/gpt-4.1',
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

  it('emits cache_control fields on the request body when routed to Anthropic', async () => {
    let capturedBody: any;
    await withServer(
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
        req.on('end', () => {
          capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'r1',
              choices: [{ message: { role: 'assistant', content: 'ok' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
        });
      },
      async baseUrl => {
        const provider = new OpenRouterProvider({ token: 'test-token', host: baseUrl });
        await provider.chatNoStream(
          'anthropic/claude-sonnet-4-6',
          [
            { role: 'system', content: 'sys', cacheBoundary: true },
            { role: 'user', content: 'hi' },
          ],
          [{ type: 'function', function: { name: 'Read', description: '', parameters: {} } }],
          { cacheTools: true },
        );

        assert.ok(capturedBody);
        const sys = capturedBody.messages[0];
        assert.deepStrictEqual(sys.content, [
          { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
        ]);
        assert.deepStrictEqual(capturedBody.tools[0].cache_control, { type: 'ephemeral' });
      },
    );
  });

  it('omits cache_control fields entirely when the model is not Anthropic', async () => {
    let capturedBody: any;
    await withServer(
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
        req.on('end', () => {
          capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'r1',
              choices: [{ message: { role: 'assistant', content: 'ok' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
        });
      },
      async baseUrl => {
        const provider = new OpenRouterProvider({ token: 'test-token', host: baseUrl });
        await provider.chatNoStream(
          'openai/gpt-4o',
          [
            { role: 'system', content: 'sys', cacheBoundary: true },
            { role: 'user', content: 'hi' },
          ],
          [{ type: 'function', function: { name: 'Read', description: '', parameters: {} } }],
          { cacheTools: true },
        );

        assert.ok(capturedBody);
        assert.strictEqual(JSON.stringify(capturedBody).includes('cache_control'), false);
      },
    );
  });
});

describe('routesToAnthropic', () => {
  it('matches anthropic/* model ids', () => {
    assert.strictEqual(routesToAnthropic('anthropic/claude-sonnet-4-6'), true);
    assert.strictEqual(routesToAnthropic('anthropic/claude-haiku-4-5'), true);
  });

  it('does not match non-Anthropic ids', () => {
    assert.strictEqual(routesToAnthropic('openai/gpt-4o'), false);
    assert.strictEqual(routesToAnthropic('mistralai/mistral-large'), false);
    assert.strictEqual(routesToAnthropic('google/gemini-2.5-pro'), false);
  });
});
