import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { streamOpenAiResponses } from '../../../../src/providers/openai/index.js';
import type { ChatChunk } from '../../../../src/providers/types.js';

function withSseServer(
  events: string[],
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const e of events) res.write(e);
      res.end();
    });
    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('no address'));
        return;
      }
      try {
        await fn(`http://127.0.0.1:${address.port}/v1/responses`);
        server.close(err => (err ? reject(err) : resolve()));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

function withFailingServer(
  status: number,
  body: string,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('no address'));
        return;
      }
      try {
        await fn(`http://127.0.0.1:${address.port}/v1/responses`);
        server.close(err => (err ? reject(err) : resolve()));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

async function collect(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

function dataLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe('streamOpenAiResponses', () => {
  it('streams output_text deltas as content chunks and yields a terminal usage chunk', async () => {
    const events = [
      dataLine({ type: 'response.created', response: { id: 'resp_1' } }),
      dataLine({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] },
      }),
      dataLine({ type: 'response.output_text.delta', output_index: 0, delta: 'hello ' }),
      dataLine({ type: 'response.output_text.delta', output_index: 0, delta: 'world' }),
      dataLine({
        type: 'response.completed',
        response: {
          id: 'resp_1',
          usage: {
            input_tokens: 5,
            output_tokens: 8,
            total_tokens: 13,
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      }),
    ];
    await withSseServer(events, async url => {
      const chunks = await collect(
        streamOpenAiResponses({
          url,
          headers: {},
          body: { model: 'gpt-5-codex' },
          providerName: 'OpenAI',
        }),
      );
      const text = chunks.map(c => c.content ?? '').join('');
      assert.strictEqual(text, 'hello world');
      const terminal = chunks[chunks.length - 1]!;
      assert.strictEqual(terminal.done, true);
      // responseId is captured from response.completed and surfaced on the
      // terminal chunk so the agent loop can chain off it next call.
      assert.strictEqual(terminal.responseId, 'resp_1');
      assert.deepStrictEqual(terminal.usage, {
        promptTokens: 5,
        completionTokens: 8,
        totalTokens: 13,
        reasoningTokens: 3,
      });
    });
  });

  it('accumulates a streamed function_call and emits it on completion', async () => {
    const events = [
      dataLine({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_42', name: 'Read' },
      }),
      dataLine({
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"file"',
      }),
      dataLine({
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: ':"x"}',
      }),
      dataLine({
        type: 'response.function_call_arguments.done',
        output_index: 0,
        name: 'Read',
        arguments: '{"file":"x"}',
      }),
      dataLine({
        type: 'response.completed',
        response: { id: 'resp_2', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
      }),
    ];
    await withSseServer(events, async url => {
      const chunks = await collect(
        streamOpenAiResponses({
          url,
          headers: {},
          body: { model: 'gpt-5-codex' },
          providerName: 'OpenAI',
        }),
      );
      const last = chunks[chunks.length - 1]!;
      assert.strictEqual(last.done, true);
      assert.deepStrictEqual(last.tool_calls, [
        { id: 'call_42', function: { name: 'Read', arguments: { file: 'x' } } },
      ]);
    });
  });

  it('throws when the stream emits response.failed', async () => {
    const events = [
      dataLine({
        type: 'response.failed',
        response: { error: { message: 'model unavailable' } },
      }),
    ];
    await withSseServer(events, async url => {
      await assert.rejects(
        () =>
          collect(
            streamOpenAiResponses({
              url,
              headers: {},
              body: { model: 'gpt-5-codex' },
              providerName: 'OpenAI',
            }),
          ),
        /model unavailable/,
      );
    });
  });

  it('surfaces non-2xx responses as a thrown provider error', async () => {
    await withFailingServer(404, '{"error":{"message":"not a chat model"}}', async url => {
      await assert.rejects(
        () =>
          collect(
            streamOpenAiResponses({
              url,
              headers: {},
              body: { model: 'gpt-5-codex' },
              providerName: 'OpenAI',
            }),
          ),
        /OpenAI API error 404/,
      );
    });
  });

  it('omits responseId from the terminal chunk when the request body has store=false', async () => {
    // The Responses API still returns an id when store=false, but it can't
    // be referenced as `previous_response_id` on a later call. Surfacing it
    // would poison the agent-layer chain pointer; the provider must hide
    // the id at the boundary so chainRef never captures an unreferenceable
    // value. Symmetric with the chat-completions path (sendOpenAiResponses).
    const events = [
      dataLine({
        type: 'response.completed',
        response: {
          id: 'resp_unstored',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }),
    ];
    await withSseServer(events, async url => {
      const chunks = await collect(
        streamOpenAiResponses({
          url,
          headers: {},
          body: { model: 'gpt-5-codex', store: false },
          providerName: 'OpenAI',
        }),
      );
      const terminal = chunks[chunks.length - 1]!;
      assert.strictEqual(terminal.done, true);
      assert.strictEqual(terminal.responseId, undefined);
    });
  });

  it('preserves responseId on the terminal chunk when store is omitted (defaults to true)', async () => {
    // Sanity counter-test for the suppression above — without store=false in
    // the body, the response is referenceable and the id must come through.
    const events = [
      dataLine({
        type: 'response.completed',
        response: {
          id: 'resp_chainable',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }),
    ];
    await withSseServer(events, async url => {
      const chunks = await collect(
        streamOpenAiResponses({
          url,
          headers: {},
          body: { model: 'gpt-5-codex' },
          providerName: 'OpenAI',
        }),
      );
      const terminal = chunks[chunks.length - 1]!;
      assert.strictEqual(terminal.responseId, 'resp_chainable');
    });
  });
});
