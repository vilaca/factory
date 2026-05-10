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

  it('throws an Error with status=500 when the stream emits response.failed without a type', async () => {
    // SSE terminal failures default to InternalServerError per OpenAI's
    // error-codes guide: "Retry your request after a brief wait." Without the
    // .status tag, classifyForRetry would never see this as a 5xx and would
    // treat it as non-retryable — which is the bug this change fixes.
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
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /model unavailable/);
          assert.strictEqual((err as Error & { status?: number }).status, 500);
          return true;
        },
      );
    });
  });

  it('tags response.error with status=429 when error.code is rate_limit_exceeded', async () => {
    // OpenAI's standard envelope is `{type:'rate_limit_error', code:'rate_limit_exceeded'}`;
    // some newer events drop the type and only carry the code. Either way the
    // code wins and we tag 429 so retry uses exponential backoff.
    const events = [
      dataLine({
        type: 'response.error',
        response: {
          error: { message: 'too many', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
        },
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
        (err: unknown) => {
          assert.strictEqual((err as Error & { status?: number }).status, 429);
          return true;
        },
      );
    });
  });

  it('tags response.failed with status=401 when code is invalid_api_key (type is the generic invalid_request_error)', async () => {
    // This is the bug-fixing case: OpenAI returns
    //   {type:'invalid_request_error', code:'invalid_api_key'}
    // for an invalid key, with HTTP semantics 401. A naive type-first
    // lookup would tag this 400, which would prevent the rotation layer
    // from swapping to a different key. The code-first lookup catches it.
    const events = [
      dataLine({
        type: 'response.failed',
        response: {
          error: { message: 'bad key', type: 'invalid_request_error', code: 'invalid_api_key' },
        },
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
        (err: unknown) => {
          assert.strictEqual((err as Error & { status?: number }).status, 401);
          return true;
        },
      );
    });
  });

  it('falls back to type when code is absent (authentication_error → 401)', async () => {
    const events = [
      dataLine({
        type: 'response.failed',
        response: { error: { message: 'unauthorized', type: 'authentication_error' } },
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
        (err: unknown) => {
          assert.strictEqual((err as Error & { status?: number }).status, 401);
          return true;
        },
      );
    });
  });

  it('tags permission_error type as 403', async () => {
    // The API type field is `permission_error`, not the Python SDK's
    // `PermissionDeniedError` exception name — the wire format wins.
    const events = [
      dataLine({
        type: 'response.failed',
        response: { error: { message: 'forbidden', type: 'permission_error' } },
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
        (err: unknown) => {
          assert.strictEqual((err as Error & { status?: number }).status, 403);
          return true;
        },
      );
    });
  });

  it('falls back to generic invalid_request_error → 400 when no specific code is set', async () => {
    const events = [
      dataLine({
        type: 'response.failed',
        response: {
          error: { message: 'bad shape', type: 'invalid_request_error' },
        },
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
        (err: unknown) => {
          assert.strictEqual((err as Error & { status?: number }).status, 400);
          return true;
        },
      );
    });
  });

  it('treats response.incomplete with max_output_tokens as a length-truncation terminal chunk, not an error', async () => {
    // This is the SSE equivalent of chat-completions' finish_reason: 'length'.
    // The agent layer has a length-truncation retry path keyed on
    // `doneReason: 'length'`; surfacing it here as a stop reason routes the
    // call into that path instead of killing the turn with a thrown error.
    const events = [
      dataLine({ type: 'response.output_text.delta', output_index: 0, delta: 'partial ' }),
      dataLine({ type: 'response.output_text.delta', output_index: 0, delta: 'answer' }),
      dataLine({
        type: 'response.incomplete',
        response: {
          id: 'resp_incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 2, output_tokens: 64, total_tokens: 66 },
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
      assert.strictEqual(text, 'partial answer');
      const terminal = chunks[chunks.length - 1]!;
      assert.strictEqual(terminal.done, true);
      assert.strictEqual(terminal.doneReason, 'length');
      assert.strictEqual(terminal.responseId, 'resp_incomplete');
      assert.deepStrictEqual(terminal.usage, {
        promptTokens: 2,
        completionTokens: 64,
        totalTokens: 66,
      });
    });
  });

  it('throws status=400 on response.incomplete with a non-length reason (e.g. content_filter)', async () => {
    // content_filter is a policy stop, not a transient failure. Routing it
    // through 400 makes it a BadRequestError-class signal: not retryable on
    // the same key, surfacing for the user instead.
    const events = [
      dataLine({
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'content_filter' } },
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
        (err: unknown) => {
          assert.strictEqual((err as Error & { status?: number }).status, 400);
          return true;
        },
      );
    });
  });

  it('surfaces non-2xx responses as a thrown provider error tagged with the HTTP status', async () => {
    await withFailingServer(503, '{"error":{"message":"engine overloaded"}}', async url => {
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
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /OpenAI API error 503/);
          assert.strictEqual((err as Error & { status?: number }).status, 503);
          return true;
        },
      );
    });
  });

  it('still tags 4xx auth failures so the rotation layer (not retry) handles them', async () => {
    await withFailingServer(401, '{"error":{"message":"invalid api key"}}', async url => {
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
        (err: unknown) => {
          assert.strictEqual((err as Error & { status?: number }).status, 401);
          return true;
        },
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
