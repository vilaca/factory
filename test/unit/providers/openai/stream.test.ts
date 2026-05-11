import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sendOpenAiChat, streamOpenAiChat } from '../../../../src/providers/openai/index.js';
import type { ChatChunk } from '../../../../src/providers/types.js';
import { makeSseHelpers } from './sse-test-helpers.js';

const { withSseServer, withFailingServer, withHangingSseServer } = makeSseHelpers(
  '/v1/chat/completions',
);

async function collect(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

function dataLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// TODO(test/refactor-timeout-probe): this helper is duplicated in
// responses-stream.test.ts; move to a shared test util.
async function expectStallAndCaptureDefaultTimeoutUsage(
  makeStream: () => AsyncGenerator<ChatChunk>,
): Promise<boolean> {
  const originalSetTimeout = globalThis.setTimeout;
  let sawDefault30sTimeout = false;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const [handler, timeout, ...rest] = args;
    if (timeout === 30_000) sawDefault30sTimeout = true;
    const adjustedTimeout = timeout === 30_000 ? 10 : timeout;
    return originalSetTimeout(handler, adjustedTimeout, ...rest);
  }) as typeof setTimeout;

  try {
    await assert.rejects(() => collect(makeStream()), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /stalled|idle timeout/i);
      assert.strictEqual((err as Error & { status?: number }).status, 504);
      return true;
    });
    return sawDefault30sTimeout;
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

describe('streamOpenAiChat', () => {
  it('tags non-2xx responses with .status so classifyForRetry can act on it', async () => {
    // The original bug: providers threw `new Error('... API error 503: ...')`
    // with the status only in the message string. classifyForRetry reads
    // err.status; without the tag, every 5xx fell through to non-retryable.
    await withFailingServer(503, '{"error":{"message":"engine overloaded"}}', async url => {
      await assert.rejects(
        () =>
          collect(
            streamOpenAiChat({
              url,
              headers: {},
              body: { model: 'gpt-4o', stream: true, messages: [] },
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

  it('tags non-streaming non-2xx responses with .status as well', async () => {
    await withFailingServer(401, '{"error":{"message":"invalid api key"}}', async url => {
      await assert.rejects(
        () =>
          sendOpenAiChat({
            url,
            headers: {},
            body: { model: 'gpt-4o', messages: [] },
            providerName: 'OpenAI',
          }),
        (err: unknown) => {
          assert.strictEqual((err as Error & { status?: number }).status, 401);
          return true;
        },
      );
    });
  });

  it('surfaces streaming finish_reason as doneReason', async () => {
    const events = [
      dataLine({ choices: [{ delta: { content: 'partial' } }] }),
      dataLine({
        choices: [{ delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
      'data: [DONE]\n\n',
    ];

    await withSseServer(events, async url => {
      const chunks = await collect(
        streamOpenAiChat({
          url,
          headers: {},
          body: { model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'hi' }] },
          providerName: 'OpenAI',
        }),
      );

      assert.strictEqual(chunks[0]?.content, 'partial');
      const terminal = chunks[chunks.length - 1]!;
      assert.strictEqual(terminal.done, true);
      assert.strictEqual(terminal.doneReason, 'length');
      assert.deepStrictEqual(terminal.usage, {
        promptTokens: 3,
        completionTokens: 4,
        totalTokens: 7,
      });
    });
  });

  it('fails a stalled SSE stream with status=504 (idle timeout)', async () => {
    const originalIdleTimeout = process.env.FACTORY_OPENAI_SSE_IDLE_TIMEOUT_MS;
    process.env.FACTORY_OPENAI_SSE_IDLE_TIMEOUT_MS = '10';
    try {
      await withHangingSseServer(async url => {
        await assert.rejects(
          () =>
            collect(
              streamOpenAiChat({
                url,
                headers: {},
                body: { model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'hi' }] },
                providerName: 'OpenAI',
              }),
            ),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /stalled|idle timeout/i);
            assert.strictEqual((err as Error & { status?: number }).status, 504);
            return true;
          },
        );
      });
    } finally {
      if (originalIdleTimeout === undefined) {
        delete process.env.FACTORY_OPENAI_SSE_IDLE_TIMEOUT_MS;
      } else {
        process.env.FACTORY_OPENAI_SSE_IDLE_TIMEOUT_MS = originalIdleTimeout;
      }
    }
  });

  it('propagates user abort from req.signal instead of rewriting it as idle-timeout', async () => {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(new Error('user aborted stream')), 10);
    try {
      await withHangingSseServer(async url => {
        await assert.rejects(
          () =>
            collect(
              streamOpenAiChat({
                url,
                headers: {},
                body: { model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'hi' }] },
                signal: controller.signal,
                providerName: 'OpenAI',
              }),
            ),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.strictEqual((err as Error & { status?: number }).status, undefined);
            assert.match(err.message, /abort/i);
            return true;
          },
        );
      });
    } finally {
      clearTimeout(abortTimer);
    }
  });

  it('defaults idle-timeout env parsing to 30s for missing/invalid/negative values', async () => {
    const originalIdleTimeout = process.env.FACTORY_OPENAI_SSE_IDLE_TIMEOUT_MS;
    const cases: Array<string | undefined> = [undefined, 'not-a-number', '-1'];
    try {
      for (const value of cases) {
        if (value === undefined) {
          delete process.env.FACTORY_OPENAI_SSE_IDLE_TIMEOUT_MS;
        } else {
          process.env.FACTORY_OPENAI_SSE_IDLE_TIMEOUT_MS = value;
        }

        await withHangingSseServer(async url => {
          const usedDefaultTimeout = await expectStallAndCaptureDefaultTimeoutUsage(() =>
            streamOpenAiChat({
              url,
              headers: {},
              body: { model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'hi' }] },
              providerName: 'OpenAI',
            }),
          );
          assert.strictEqual(usedDefaultTimeout, true);
        });
      }
    } finally {
      if (originalIdleTimeout === undefined) {
        delete process.env.FACTORY_OPENAI_SSE_IDLE_TIMEOUT_MS;
      } else {
        process.env.FACTORY_OPENAI_SSE_IDLE_TIMEOUT_MS = originalIdleTimeout;
      }
    }
  });
});
