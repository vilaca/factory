import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { handleAgentEvent } from '../../../../../src/ui/ink/agent-loop/event-handler.js';
import type { AgentLoopDeps, RunRefs } from '../../../../../src/ui/ink/agent-loop/types.js';

// The event handler is a thin dispatch table; we exercise just the activity-
// label branches (provider-retry, key-rotation, tuple-rotation, text-chunk,
// turn-complete) — the spots that drive the StatusBar's transient label.

interface FakeDeps {
  setActivity: ReturnType<typeof mock.fn>;
  setThinking: ReturnType<typeof mock.fn>;
  setStreamingText: ReturnType<typeof mock.fn>;
  addNotice: ReturnType<typeof mock.fn>;
  setSessionTurns: ReturnType<typeof mock.fn>;
  setLastUsage: ReturnType<typeof mock.fn>;
  setPendingToolCall: ReturnType<typeof mock.fn>;
}

function fakeDeps(): { deps: AgentLoopDeps; calls: FakeDeps } {
  const calls: FakeDeps = {
    setActivity: mock.fn(),
    setThinking: mock.fn(),
    setStreamingText: mock.fn(),
    addNotice: mock.fn(),
    setSessionTurns: mock.fn(),
    setLastUsage: mock.fn(),
    setPendingToolCall: mock.fn(),
  };
  // Cast through unknown — tests only exercise the methods our handlers call,
  // and we don't want to stub the entire 30-method surface.
  const deps = {
    refs: { current: { activeKeyId: undefined } as unknown as RunRefs },
    addItem: mock.fn(),
    addNotice: calls.addNotice,
    nextId: mock.fn(() => 1),
    refreshTokenEstimate: mock.fn(),
    composeSystemPrompt: mock.fn(() => ''),
    setState: mock.fn(),
    setThinking: calls.setThinking,
    setRunningTool: mock.fn(),
    setActivity: calls.setActivity,
    setStreamingText: calls.setStreamingText,
    setCompacting: mock.fn(),
    setSessionTurns: calls.setSessionTurns,
    setSessionToolCalls: mock.fn(),
    setLastUsage: calls.setLastUsage,
    setPermissionRequest: mock.fn(),
    setPendingToolCall: calls.setPendingToolCall,
    setPlannedCalls: mock.fn(),
    getPlannedCalls: mock.fn(() => []),
  } as unknown as AgentLoopDeps;
  return { deps, calls };
}

const ss = {
  getStreamingBuffer: () => '',
  setStreamingBuffer: () => {},
  addSuccessfulToolCall: () => {},
  markAutoRetryExhausted: () => {},
  markTokenLimitHalt: () => {},
};

describe('event-handler — activity surface', () => {
  it('provider-retry sets a labeled activity with attempt and delay', () => {
    const { deps, calls } = fakeDeps();
    handleAgentEvent(
      {
        type: 'provider-retry',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1100,
        reason: 'server-error',
      },
      deps,
      ss,
    );
    assert.strictEqual(calls.setActivity.mock.callCount(), 1);
    const label = calls.setActivity.mock.calls[0]!.arguments[0] as string;
    assert.match(label, /retrying 2\/3/);
    assert.match(label, /server-error/);
    assert.match(label, /1\.1s/);
  });

  it('text-chunk clears the activity (forward progress)', () => {
    const { deps, calls } = fakeDeps();
    handleAgentEvent({ type: 'text-chunk', content: 'hello' }, deps, ss);
    // First call clears any prior activity; subsequent text-chunks during
    // the same response also call setActivity(null) — that's idempotent.
    assert.strictEqual(calls.setActivity.mock.callCount(), 1);
    assert.strictEqual(calls.setActivity.mock.calls[0]!.arguments[0], null);
  });

  it('key-rotation sets a "rotating key (<reason>)" activity', () => {
    const { deps, calls } = fakeDeps();
    handleAgentEvent(
      {
        type: 'key-rotation',
        provider: 'anthropic',
        from: { keyId: 'a', fingerprint: 'aaaa' },
        to: { keyId: 'b', fingerprint: 'bbbb' },
        reason: 'rate-limit',
      },
      deps,
      ss,
    );
    assert.strictEqual(calls.setActivity.mock.callCount(), 1);
    assert.match(calls.setActivity.mock.calls[0]!.arguments[0] as string, /rotating key.*rate-limit/);
  });

  it('tuple-rotation sets a "rotating: <from> → <to>" activity', () => {
    const { deps, calls } = fakeDeps();
    handleAgentEvent(
      {
        type: 'tuple-rotation',
        from: { provider: 'anthropic', model: 'm1' },
        to: { provider: 'openrouter', model: 'm2' },
        reason: 'auth',
      },
      deps,
      ss,
    );
    assert.strictEqual(calls.setActivity.mock.callCount(), 1);
    const label = calls.setActivity.mock.calls[0]!.arguments[0] as string;
    assert.match(label, /anthropic/);
    assert.match(label, /openrouter/);
    assert.match(label, /auth/);
  });

  it('turn-complete clears any leftover activity even on error', () => {
    const { deps, calls } = fakeDeps();
    handleAgentEvent(
      { type: 'turn-complete', stopReason: 'error', turnsUsed: 1 },
      deps,
      ss,
    );
    assert.strictEqual(calls.setActivity.mock.callCount(), 1);
    assert.strictEqual(calls.setActivity.mock.calls[0]!.arguments[0], null);
  });
});
