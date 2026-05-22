import { describe, it } from 'node:test';
import assert from 'node:assert';
import { makeRotationWrap } from '../../../../../src/ui/tui/agent-loop/run-loop.js';
import type {
  ChatChunk,
  ChatMessage,
  Provider,
  ProviderCapabilities,
} from '../../../../../src/providers/types.js';
import type { SessionLogger } from '../../../../../src/core/session/session-log.js';

function fakeCaps(): ProviderCapabilities {
  return {
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    toolSupport: 'native',
    parallelToolCalls: true,
    streaming: true,
    tokenCounting: 'estimated',
    modelTier: 'medium',
  };
}

function fakeProvider(name: string): Provider {
  async function* stream(): AsyncGenerator<ChatChunk> {
    yield { content: 'ok', done: true };
  }
  return {
    name,
    async listModels() {
      return ['m1'];
    },
    getCapabilities(_m: string) {
      return fakeCaps();
    },
    chat(_model: string, _messages: ChatMessage[]) {
      return stream();
    },
    async chatNoStream(_model: string, _messages: ChatMessage[]) {
      return { content: 'done', done: true } as ChatChunk;
    },
  } as unknown as Provider;
}

// Regression pin for the rotation instrumentation gap: `buildRotationOptions`
// in run-loop.ts wires `withKey` and `withTuple`. Before the fix, those
// lambdas returned raw `createProvider(...)` instances, so mid-stream
// rotation bypassed the session log. The fix wraps via `makeRotationWrap`.
// Exercising the helper directly is enough to assert the contract — the
// wider rotation control flow is already covered by call-model-rotation.test.ts.

describe('makeRotationWrap', () => {
  it('returns the provider unchanged when no session logger is attached', () => {
    const inner = fakeProvider('inner');
    const wrap = makeRotationWrap(undefined);
    const result = wrap(inner);
    assert.strictEqual(result, inner, 'no logger → identity wrap');
  });

  it('wraps with instrumentation so every chat / chatNoStream call lands in the session log', async () => {
    const inner = fakeProvider('inner');
    const calls: Array<{ type: string; source: string; model: string }> = [];
    const logger: SessionLogger = {
      filePath: '/dev/null',
      logSessionStart: () => {},
      logProviderAuth: () => {},
      logUserInput: () => {},
      logAgentEvent: () => {},
      logCommand: () => {},
      logModelChange: () => {},
      logSystemPrompt: () => {},
      logSystemPromptChange: () => {},
      logPermissionChange: () => {},
      logStuckPattern: () => {},
      logWarning: () => {},
      logGitChange: () => {},
      logModelRequest: meta => {
        calls.push({ type: 'model-request', source: meta.source, model: meta.model });
      },
      logSessionEnd: () => {},
      close: () => {},
    };

    const wrap = makeRotationWrap(logger);
    const wrapped = wrap(inner);
    // The wrapper produces a NEW Provider instance — the agent loop's
    // reference-identity checks must still work, but `wrapped` shouldn't be
    // the inner itself (otherwise the wrap silently did nothing).
    assert.notStrictEqual(wrapped, inner, 'logger present → wrap must produce a new instance');

    // Drive both call paths.
    for await (const _ of wrapped.chat('m-stream', [{ role: 'user', content: 'a' }])) {
      // exhaust stream
    }
    await wrapped.chatNoStream('m-oneshot', [{ role: 'user', content: 'b' }]);

    assert.equal(calls.length, 2, `expected 2 logged requests, got ${JSON.stringify(calls)}`);
    assert.deepEqual(calls.map(c => c.model).sort(), ['m-oneshot', 'm-stream']);
    // Default source from rotation wrap is `main` — rotation-spawned providers
    // replace the active provider, so the same tag is correct.
    for (const c of calls) assert.equal(c.source, 'main');
  });
});
