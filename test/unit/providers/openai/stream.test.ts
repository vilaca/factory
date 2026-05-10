import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { streamOpenAiChat } from '../../../../src/providers/openai/index.js';
import type { ChatChunk } from '../../../../src/providers/types.js';

function withSseServer(events: string[], fn: (url: string) => Promise<void>): Promise<void> {
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
        await fn(`http://127.0.0.1:${address.port}/v1/chat/completions`);
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

describe('streamOpenAiChat', () => {
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
});
