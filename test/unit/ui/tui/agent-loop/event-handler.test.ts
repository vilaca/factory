import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { handleAgentEvent } from '../../../../../src/ui/tui/agent-loop/event-handler.js';
import type {
  AgentLoopDeps,
  RunRefs,
} from '../../../../../src/ui/tui/agent-loop/agent-loop-types.js';

// Sister to event-handler-activity.test.ts — covers the rest of the dispatch
// table: tool result rendering, recovery/rotation notices, hooks, compaction,
// permission flow, and the dispatcher's own guard rails.

interface FakeRefs {
  useTextToolFallback?: boolean;
  activeKeyId?: string;
  provider?: { name: string };
  experimental?: { toolPreview?: boolean };
  skills?: { recordToolUsed: ReturnType<typeof mock.fn> };
  sessionLogger?: {
    logSystemPromptChange: ReturnType<typeof mock.fn>;
    logPermissionChange: ReturnType<typeof mock.fn>;
    logModelChange?: ReturnType<typeof mock.fn>;
  };
  model?: string;
  conversation?: { updateSystemPrompt: ReturnType<typeof mock.fn> };
}

interface FakeDeps {
  addItem: ReturnType<typeof mock.fn>;
  addNotice: ReturnType<typeof mock.fn>;
  setActivity: ReturnType<typeof mock.fn>;
  setThinking: ReturnType<typeof mock.fn>;
  setStreamingText: ReturnType<typeof mock.fn>;
  setRunningTool: ReturnType<typeof mock.fn>;
  setPendingToolCall: ReturnType<typeof mock.fn>;
  setPermissionRequest: ReturnType<typeof mock.fn>;
  setPlannedCalls: ReturnType<typeof mock.fn>;
  setSessionToolCalls: ReturnType<typeof mock.fn>;
  setSessionTurns: ReturnType<typeof mock.fn>;
  setLastUsage: ReturnType<typeof mock.fn>;
  setCompacting: ReturnType<typeof mock.fn>;
  setState: ReturnType<typeof mock.fn>;
  refreshTokenEstimate: ReturnType<typeof mock.fn>;
  composeSystemPrompt: ReturnType<typeof mock.fn>;
  getPlannedCalls: ReturnType<typeof mock.fn>;
  refs: { current: RunRefs | null };
}

function fakeDeps(refsOverride: FakeRefs | null = {}): {
  deps: AgentLoopDeps;
  calls: FakeDeps;
} {
  const refs = refsOverride === null ? null : (refsOverride as unknown as RunRefs);
  const calls: FakeDeps = {
    addItem: mock.fn(),
    addNotice: mock.fn(),
    setActivity: mock.fn(),
    setThinking: mock.fn(),
    setStreamingText: mock.fn(),
    setRunningTool: mock.fn(),
    setPendingToolCall: mock.fn(),
    setPermissionRequest: mock.fn(),
    setPlannedCalls: mock.fn(),
    setSessionToolCalls: mock.fn(),
    setSessionTurns: mock.fn(),
    setLastUsage: mock.fn(),
    setCompacting: mock.fn(),
    setState: mock.fn(),
    refreshTokenEstimate: mock.fn(),
    composeSystemPrompt: mock.fn(() => 'composed-prompt'),
    getPlannedCalls: mock.fn(() => [] as { toolName: string; args: unknown }[]),
    refs: { current: refs },
  };
  let nextId = 0;
  const deps = {
    refs: calls.refs,
    addItem: calls.addItem,
    addNotice: calls.addNotice,
    nextId: () => ++nextId,
    refreshTokenEstimate: calls.refreshTokenEstimate,
    composeSystemPrompt: calls.composeSystemPrompt,
    setState: calls.setState,
    setThinking: calls.setThinking,
    setRunningTool: calls.setRunningTool,
    setActivity: calls.setActivity,
    setStreamingText: calls.setStreamingText,
    setCompacting: calls.setCompacting,
    setSessionTurns: calls.setSessionTurns,
    setSessionToolCalls: calls.setSessionToolCalls,
    setLastUsage: calls.setLastUsage,
    setPermissionRequest: calls.setPermissionRequest,
    setPendingToolCall: calls.setPendingToolCall,
    setPlannedCalls: calls.setPlannedCalls,
    getPlannedCalls: calls.getPlannedCalls,
  } as unknown as AgentLoopDeps;
  return { deps, calls };
}

function makeSs() {
  let buf = '';
  const successes: number[] = [];
  const flags = { autoRetryExhausted: 0, tokenLimit: 0 };
  return {
    ss: {
      getStreamingBuffer: () => buf,
      setStreamingBuffer: (s: string) => {
        buf = s;
      },
      addSuccessfulToolCall: () => successes.push(1),
      markAutoRetryExhausted: () => flags.autoRetryExhausted++,
      markTokenLimitHalt: () => flags.tokenLimit++,
    },
    successes,
    flags,
    getBuf: () => buf,
  };
}

describe('event-handler — text streaming', () => {
  it('text-chunk appends to the streaming buffer and forwards to setStreamingText', () => {
    const { deps, calls } = fakeDeps();
    const { ss, getBuf } = makeSs();
    handleAgentEvent({ type: 'text-chunk', content: 'hello ' }, deps, ss);
    handleAgentEvent({ type: 'text-chunk', content: 'world' }, deps, ss);
    assert.strictEqual(getBuf(), 'hello world');
    assert.strictEqual(calls.setStreamingText.mock.callCount(), 2);
    assert.strictEqual(calls.setStreamingText.mock.calls[1]!.arguments[0], 'hello world');
    assert.strictEqual(calls.setThinking.mock.callCount(), 2);
  });

  it('text-done with content commits an assistant-text item and refreshes tokens', () => {
    const { deps, calls } = fakeDeps();
    const { ss } = makeSs();
    handleAgentEvent({ type: 'text-done', fullContent: 'final' }, deps, ss);
    assert.strictEqual(calls.addItem.mock.callCount(), 1);
    const item = calls.addItem.mock.calls[0]!.arguments[0] as {
      kind: string;
      text: string;
      streaming: boolean;
    };
    assert.strictEqual(item.kind, 'assistant-text');
    assert.strictEqual(item.text, 'final');
    assert.strictEqual(item.streaming, false);
    assert.strictEqual(calls.setStreamingText.mock.calls[0]!.arguments[0], '');
    assert.strictEqual(calls.refreshTokenEstimate.mock.callCount(), 1);
  });

  it('text-done with empty content skips the addItem call', () => {
    const { deps, calls } = fakeDeps();
    const { ss } = makeSs();
    handleAgentEvent({ type: 'text-done', fullContent: '' }, deps, ss);
    assert.strictEqual(calls.addItem.mock.callCount(), 0);
    assert.strictEqual(calls.setStreamingText.mock.calls[0]!.arguments[0], '');
  });
});

describe('event-handler — tool lifecycle', () => {
  const baseArgs = { foo: 'bar' };

  it('tool-call-start parks the call as pending', () => {
    const { deps, calls } = fakeDeps();
    const { ss } = makeSs();
    handleAgentEvent({ type: 'tool-call-start', toolName: 'Bash', args: baseArgs }, deps, ss);
    assert.strictEqual(calls.setRunningTool.mock.calls[0]!.arguments[0], 'Bash');
    assert.deepStrictEqual(calls.setPendingToolCall.mock.calls[0]!.arguments[0], {
      toolName: 'Bash',
      args: baseArgs,
    });
  });

  it('tool-call-result hides plain successful results when toolPreview is off', () => {
    const skills = { recordToolUsed: mock.fn() };
    const { deps, calls } = fakeDeps({ skills, experimental: {} });
    const { ss, successes } = makeSs();
    handleAgentEvent(
      {
        type: 'tool-call-result',
        toolName: 'Read',
        args: baseArgs,
        result: { success: true, output: 'noise body' },
      },
      deps,
      ss,
    );
    // Pending cleared + tool-call entry committed, but no tool-result entry.
    assert.strictEqual(calls.setPendingToolCall.mock.calls[0]!.arguments[0], null);
    const kinds = calls.addItem.mock.calls.map(c => (c.arguments[0] as { kind: string }).kind);
    assert.deepStrictEqual(kinds, ['tool-call']);
    assert.strictEqual(successes.length, 1);
    assert.strictEqual(skills.recordToolUsed.mock.calls[0]!.arguments[0], 'Read');
    assert.strictEqual(calls.setSessionToolCalls.mock.callCount(), 1);
  });

  it('tool-call-result renders the body for failures and uses displayOutput when shorter', () => {
    const skills = { recordToolUsed: mock.fn() };
    const { deps, calls } = fakeDeps({ skills, experimental: {} });
    const { ss, successes } = makeSs();
    handleAgentEvent(
      {
        type: 'tool-call-result',
        toolName: 'Bash',
        args: baseArgs,
        result: {
          success: false,
          output: 'full body',
          displayOutput: 'short',
        },
      },
      deps,
      ss,
    );
    assert.strictEqual(successes.length, 0);
    const items = calls.addItem.mock.calls.map(c => c.arguments[0] as { kind: string });
    const result = items.find(i => i.kind === 'tool-result') as
      | { output: string; outputFull?: string; success: boolean }
      | undefined;
    assert.ok(result);
    assert.strictEqual(result!.output, 'short');
    assert.strictEqual(result!.outputFull, 'full body');
    assert.strictEqual(result!.success, false);
  });

  it('tool-call-result renders successful results when toolPreview is on (no outputFull when same)', () => {
    const skills = { recordToolUsed: mock.fn() };
    const { deps, calls } = fakeDeps({ skills, experimental: { toolPreview: true } });
    const { ss } = makeSs();
    handleAgentEvent(
      {
        type: 'tool-call-result',
        toolName: 'Read',
        args: baseArgs,
        result: { success: true, output: 'same' },
      },
      deps,
      ss,
    );
    const result = calls.addItem.mock.calls
      .map(c => c.arguments[0] as { kind: string; outputFull?: string })
      .find(i => i.kind === 'tool-result');
    assert.ok(result);
    assert.strictEqual(result!.outputFull, undefined);
  });

  it('tool-call-result renders important successes (e.g. Bash non-zero exit)', () => {
    const skills = { recordToolUsed: mock.fn() };
    const { deps, calls } = fakeDeps({ skills, experimental: {} });
    const { ss } = makeSs();
    handleAgentEvent(
      {
        type: 'tool-call-result',
        toolName: 'Bash',
        args: baseArgs,
        result: { success: true, output: 'exit 1', important: true },
      },
      deps,
      ss,
    );
    const kinds = calls.addItem.mock.calls.map(c => (c.arguments[0] as { kind: string }).kind);
    assert.ok(kinds.includes('tool-result'));
  });

  it('tool-call-result renders empty successes (zero-match case)', () => {
    const skills = { recordToolUsed: mock.fn() };
    const { deps, calls } = fakeDeps({ skills, experimental: {} });
    const { ss } = makeSs();
    handleAgentEvent(
      {
        type: 'tool-call-result',
        toolName: 'Grep',
        args: baseArgs,
        result: { success: true, output: '', empty: true },
      },
      deps,
      ss,
    );
    const result = calls.addItem.mock.calls
      .map(c => c.arguments[0] as { kind: string; empty?: boolean })
      .find(i => i.kind === 'tool-result');
    assert.ok(result);
    assert.strictEqual(result!.empty, true);
  });

  it('tool-call-denied commits a denied tool-call entry without a result entry', () => {
    const { deps, calls } = fakeDeps();
    const { ss } = makeSs();
    handleAgentEvent({ type: 'tool-call-denied', toolName: 'Bash', args: baseArgs }, deps, ss);
    const kinds = calls.addItem.mock.calls.map(c => (c.arguments[0] as { kind: string }).kind);
    assert.deepStrictEqual(kinds, ['tool-call']);
    const item = calls.addItem.mock.calls[0]!.arguments[0] as { status: string };
    assert.strictEqual(item.status, 'denied');
    assert.strictEqual(calls.setPendingToolCall.mock.calls[0]!.arguments[0], null);
    assert.strictEqual(calls.setRunningTool.mock.calls[0]!.arguments[0], null);
  });
});

describe('event-handler — recovery & rotation notices', () => {
  it('tool-call-recovered enables fallback and emits two warn notices on first hit', () => {
    const sessionLogger = {
      logSystemPromptChange: mock.fn(),
      logPermissionChange: mock.fn(),
    };
    const conversation = { updateSystemPrompt: mock.fn() };
    const refs: FakeRefs = {
      useTextToolFallback: false,
      sessionLogger,
      conversation,
    };
    const { deps, calls } = fakeDeps(refs);
    const { ss } = makeSs();
    handleAgentEvent({ type: 'tool-call-recovered', count: 1, source: 'fence' }, deps, ss);
    assert.strictEqual(calls.addNotice.mock.callCount(), 2);
    const first = calls.addNotice.mock.calls[0]!.arguments as [string, string];
    assert.match(first[1], /JSON code block/);
    assert.match(first[1], /Recovered 1 call /);
    assert.strictEqual((deps.refs.current as unknown as FakeRefs).useTextToolFallback, true);
    assert.strictEqual(conversation.updateSystemPrompt.mock.callCount(), 1);
    assert.strictEqual(
      conversation.updateSystemPrompt.mock.calls[0]!.arguments[0],
      'composed-prompt',
    );
    assert.strictEqual(sessionLogger.logSystemPromptChange.mock.callCount(), 1);
  });

  it('tool-call-recovered is silent once useTextToolFallback is already on', () => {
    const refs: FakeRefs = { useTextToolFallback: true };
    const { deps, calls } = fakeDeps(refs);
    const { ss } = makeSs();
    handleAgentEvent({ type: 'tool-call-recovered', count: 3, source: 'bare' }, deps, ss);
    assert.strictEqual(calls.addNotice.mock.callCount(), 0);
  });

  it('tool-call-recovered describes shell-fence and tag/function-tag sources', () => {
    for (const source of ['shell-fence', 'tag', 'function-tag'] as const) {
      const refs: FakeRefs = {
        useTextToolFallback: false,
        sessionLogger: {
          logSystemPromptChange: mock.fn(),
          logPermissionChange: mock.fn(),
        },
        conversation: { updateSystemPrompt: mock.fn() },
      };
      const { deps, calls } = fakeDeps(refs);
      const { ss } = makeSs();
      handleAgentEvent({ type: 'tool-call-recovered', count: 2, source }, deps, ss);
      const first = calls.addNotice.mock.calls[0]!.arguments[1] as string;
      if (source === 'shell-fence') assert.match(first, /shell code block/);
      else assert.match(first, /tagged JSON/);
      assert.match(first, /Recovered 2 calls/);
    }
  });

  it('key-rotation handles a missing `from` and a labeled `to`', () => {
    const { deps, calls } = fakeDeps({});
    const { ss } = makeSs();
    handleAgentEvent(
      {
        type: 'key-rotation',
        provider: 'anthropic',
        from: null,
        to: { keyId: 'b', fingerprint: 'bbbb', label: 'work' },
        reason: 'auth',
      },
      deps,
      ss,
    );
    const text = calls.addNotice.mock.calls[0]!.arguments[1] as string;
    assert.match(text, /<unknown>/);
    assert.match(text, /work · …bbbb/);
    assert.match(text, /auth failed/);
  });

  it('key-rotation logs a same-model model-change so rollup tracks the new keyId', () => {
    const logModelChange = mock.fn();
    const { deps } = fakeDeps({
      model: 'claude-sonnet-4-6',
      sessionLogger: {
        logSystemPromptChange: mock.fn(),
        logPermissionChange: mock.fn(),
        logModelChange,
      },
    });
    const { ss } = makeSs();
    handleAgentEvent(
      {
        type: 'key-rotation',
        provider: 'anthropic',
        from: { keyId: 'k1', fingerprint: 'aaaa' },
        to: { keyId: 'k2', fingerprint: 'bbbb' },
        reason: 'rate-limit',
      },
      deps,
      ss,
    );
    assert.strictEqual(logModelChange.mock.callCount(), 1);
    assert.deepStrictEqual(logModelChange.mock.calls[0]!.arguments, [
      'claude-sonnet-4-6',
      'claude-sonnet-4-6',
      'k2',
    ]);
  });

  it('key-rotation skips logging when refs is null (defensive)', () => {
    const { deps } = fakeDeps(null);
    const { ss } = makeSs();
    // Just must not throw.
    handleAgentEvent(
      {
        type: 'key-rotation',
        provider: 'anthropic',
        from: null,
        to: { keyId: 'b', fingerprint: 'bbbb' },
        reason: 'auth',
      },
      deps,
      ss,
    );
  });

  it('tuple-rotation logs a model-change with providerAfter so recents reflect the new tuple', () => {
    const logModelChange = mock.fn();
    const { deps } = fakeDeps({
      activeKeyId: 'openai-key-1',
      sessionLogger: {
        logSystemPromptChange: mock.fn(),
        logPermissionChange: mock.fn(),
        logModelChange,
      },
    });
    const { ss } = makeSs();
    handleAgentEvent(
      {
        type: 'tuple-rotation',
        from: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        to: { provider: 'openai', model: 'gpt-4.1' },
        reason: 'rate-limit',
      },
      deps,
      ss,
    );
    assert.strictEqual(logModelChange.mock.callCount(), 1);
    assert.deepStrictEqual(logModelChange.mock.calls[0]!.arguments, [
      'claude-sonnet-4-6',
      'gpt-4.1',
      'openai-key-1',
      'openai',
    ]);
  });

  it('key-rotation-exhausted records a failure for the active key', () => {
    const { deps, calls } = fakeDeps({ activeKeyId: 'k1' });
    const { ss } = makeSs();
    handleAgentEvent(
      { type: 'key-rotation-exhausted', provider: 'anthropic', reason: 'auth' },
      deps,
      ss,
    );
    assert.strictEqual(calls.addNotice.mock.callCount(), 1);
    assert.match(
      calls.addNotice.mock.calls[0]!.arguments[1] as string,
      /no more keys for anthropic/,
    );
  });

  it('key-rotation-exhausted is a no-op for the recorder when no active key is set', () => {
    const { deps, calls } = fakeDeps({});
    const { ss } = makeSs();
    handleAgentEvent(
      { type: 'key-rotation-exhausted', provider: 'anthropic', reason: 'rate-limit' },
      deps,
      ss,
    );
    // The notice still fires — only the recordFailure side-effect is gated.
    assert.strictEqual(calls.addNotice.mock.callCount(), 1);
  });

  it('tuple-rotation-exhausted surfaces the chain-exhausted warning', () => {
    const { deps, calls } = fakeDeps({});
    const { ss } = makeSs();
    handleAgentEvent({ type: 'tuple-rotation-exhausted', reason: 'rate-limit' }, deps, ss);
    assert.match(
      calls.addNotice.mock.calls[0]!.arguments[1] as string,
      /rotation chain exhausted.*rate-limited/,
    );
  });
});

describe('event-handler — corrector + retry notices', () => {
  it('tool-result-imitation-stripped pluralizes correctly', () => {
    const { deps, calls } = fakeDeps();
    const { ss } = makeSs();
    handleAgentEvent({ type: 'tool-result-imitation-stripped', count: 1 }, deps, ss);
    handleAgentEvent({ type: 'tool-result-imitation-stripped', count: 2 }, deps, ss);
    const m1 = calls.addNotice.mock.calls[0]!.arguments[1] as string;
    const m2 = calls.addNotice.mock.calls[1]!.arguments[1] as string;
    assert.match(m1, /1 tool result block/);
    assert.match(m2, /2 tool result blocks/);
  });

  it('auto-retry-injected pluralizes "retr(y|ies)"', () => {
    const { deps, calls } = fakeDeps();
    const { ss } = makeSs();
    handleAgentEvent(
      { type: 'auto-retry-injected', remainingBudget: 1, reason: 'no-tool' },
      deps,
      ss,
    );
    handleAgentEvent(
      { type: 'auto-retry-injected', remainingBudget: 3, reason: 'no-tool' },
      deps,
      ss,
    );
    assert.match(calls.addNotice.mock.calls[0]!.arguments[1] as string, /1 retry left/);
    assert.match(calls.addNotice.mock.calls[1]!.arguments[1] as string, /3 retries left/);
  });

  it('auto-retry-exhausted flips the streaming-state flag and emits a notice', () => {
    const { deps, calls } = fakeDeps();
    const { ss, flags } = makeSs();
    handleAgentEvent({ type: 'auto-retry-exhausted' }, deps, ss);
    assert.strictEqual(flags.autoRetryExhausted, 1);
    assert.strictEqual(calls.addNotice.mock.callCount(), 1);
  });

  it('all-denied-halt pluralizes the count', () => {
    const { deps, calls } = fakeDeps();
    const { ss } = makeSs();
    handleAgentEvent({ type: 'all-denied-halt', count: 1 }, deps, ss);
    handleAgentEvent({ type: 'all-denied-halt', count: 4 }, deps, ss);
    assert.match(calls.addNotice.mock.calls[0]!.arguments[1] as string, /All 1 tool call /);
    assert.match(calls.addNotice.mock.calls[1]!.arguments[1] as string, /All 4 tool calls /);
  });

  it('tool-call-corrected and tool-call-corrector-aborted truncate long reason strings', () => {
    const { deps, calls } = fakeDeps();
    const { ss } = makeSs();
    const longReason = 'x'.repeat(200);
    handleAgentEvent(
      {
        type: 'tool-call-corrected',
        original: { id: '1', function: { name: 'Bash', arguments: '{}' } } as never,
        corrected: { id: '1', function: { name: 'Bash', arguments: '{}' } } as never,
        reason: longReason,
      },
      deps,
      ss,
    );
    handleAgentEvent({ type: 'tool-call-corrector-aborted', reason: longReason }, deps, ss);
    const corrected = calls.addNotice.mock.calls[0]!.arguments[1] as string;
    const aborted = calls.addNotice.mock.calls[1]!.arguments[1] as string;
    assert.ok(corrected.length < longReason.length);
    assert.ok(aborted.length < longReason.length);
    assert.match(corrected, /Auto-correcting Bash/);
    assert.match(aborted, /Corrector skipped:/);
  });
});

describe('event-handler — planned tool calls', () => {
  it('records a new tool-planned entry', () => {
    const { deps, calls } = fakeDeps();
    const { ss } = makeSs();
    handleAgentEvent(
      { type: 'tool-call-planned', toolName: 'Bash', args: { cmd: 'ls' } },
      deps,
      ss,
    );
    assert.strictEqual(calls.setPlannedCalls.mock.callCount(), 1);
    const updater = calls.setPlannedCalls.mock.calls[0]!.arguments[0] as (
      prev: { toolName: string; args: unknown }[],
    ) => { toolName: string; args: unknown }[];
    assert.deepStrictEqual(updater([]), [{ toolName: 'Bash', args: { cmd: 'ls' } }]);
    const item = calls.addItem.mock.calls[0]!.arguments[0] as { kind: string };
    assert.strictEqual(item.kind, 'tool-planned');
  });

  it('skips a duplicate planned call and emits an info notice', () => {
    const { deps, calls } = fakeDeps();
    calls.getPlannedCalls.mock.mockImplementation(() => [
      { toolName: 'Bash', args: { cmd: 'ls' } },
    ]);
    const { ss } = makeSs();
    handleAgentEvent(
      { type: 'tool-call-planned', toolName: 'Bash', args: { cmd: 'ls' } },
      deps,
      ss,
    );
    assert.strictEqual(calls.setPlannedCalls.mock.callCount(), 0);
    assert.strictEqual(calls.addItem.mock.callCount(), 0);
    assert.strictEqual(calls.addNotice.mock.callCount(), 1);
    assert.match(calls.addNotice.mock.calls[0]!.arguments[1] as string, /skipped duplicate Bash/);
  });
});

describe('event-handler — permission flow', () => {
  it('permission-request stores a resolve callback that forwards to the provided respond fn', () => {
    const sessionLogger = {
      logSystemPromptChange: mock.fn(),
      logPermissionChange: mock.fn(),
    };
    const { deps, calls } = fakeDeps({ sessionLogger });
    const { ss } = makeSs();
    const respond = mock.fn();
    handleAgentEvent(
      {
        type: 'permission-request',
        toolName: 'Bash',
        args: { cmd: 'rm -rf' },
        respond: respond as never,
      },
      deps,
      ss,
    );
    assert.strictEqual(calls.setState.mock.calls[0]!.arguments[0], 'awaiting-permission');
    const stored = calls.setPermissionRequest.mock.calls[0]!.arguments[0] as {
      resolve: (d: 'allow' | 'deny') => void;
    };
    stored.resolve('allow');
    assert.strictEqual(respond.mock.calls[0]!.arguments[0], 'allow');
    assert.strictEqual(sessionLogger.logPermissionChange.mock.callCount(), 1);
    assert.deepStrictEqual(sessionLogger.logPermissionChange.mock.calls[0]!.arguments, [
      'request:allow',
      'Bash',
    ]);
    // Resolve clears the dialog and returns the loop to running.
    assert.strictEqual(calls.setPermissionRequest.mock.callCount(), 2);
    assert.strictEqual(calls.setPermissionRequest.mock.calls[1]!.arguments[0], undefined);
    assert.strictEqual(calls.setState.mock.calls[1]!.arguments[0], 'running');
  });
});

describe('event-handler — misc notice handlers', () => {
  it('output-cap-reached, empty-turn-warning, repetition-detected, read-cache-hit, bash-dedup-nudge each emit a notice', () => {
    const { deps, calls } = fakeDeps();
    const { ss } = makeSs();
    handleAgentEvent({ type: 'output-cap-reached', completionTokens: 4096 }, deps, ss);
    handleAgentEvent({ type: 'empty-turn-warning', completionTokens: 200 }, deps, ss);
    handleAgentEvent({ type: 'repetition-detected', line: 'looped line', streak: 12 }, deps, ss);
    handleAgentEvent(
      { type: 'read-cache-hit', path: '/tmp/foo.txt', afterCompaction: false },
      deps,
      ss,
    );
    handleAgentEvent({ type: 'bash-dedup-nudge', recentCommands: ['ls', 'ls -la'] }, deps, ss);
    const texts = calls.addNotice.mock.calls.map(c => c.arguments[1] as string);
    assert.match(texts[0]!, /Output cap reached \(4096/);
    assert.match(texts[1]!, /200 tokens of internal reasoning/);
    assert.match(texts[2]!, /12 identical lines/);
    assert.match(texts[3]!, /Read cache hit/);
    assert.match(texts[4]!, /2 recent commands/);
  });

  it('hook-veto formats with and without an errorMessage, hook-error always shows the error', () => {
    const { deps, calls } = fakeDeps();
    const { ss } = makeSs();
    handleAgentEvent(
      { type: 'hook-veto', event: 'PreToolUse', toolName: 'Bash', errorMessage: 'nope' },
      deps,
      ss,
    );
    handleAgentEvent({ type: 'hook-veto', event: 'PreToolUse', toolName: 'Bash' }, deps, ss);
    handleAgentEvent({ type: 'hook-error', event: 'PostToolUse', error: 'boom' }, deps, ss);
    const a = calls.addNotice.mock.calls[0]!.arguments[1] as string;
    const b = calls.addNotice.mock.calls[1]!.arguments[1] as string;
    const c = calls.addNotice.mock.calls[2]!.arguments[1] as string;
    assert.match(a, /vetoed Bash — nope/);
    assert.match(b, /vetoed Bash$/);
    assert.match(c, /Hook PostToolUse: boom/);
  });

  it('hook-fired uses the script basename and appends the optional notice', () => {
    const { deps, calls } = fakeDeps();
    const { ss } = makeSs();
    handleAgentEvent(
      {
        type: 'hook-fired',
        event: 'Stop',
        hookCommand: '/usr/local/bin/notify.sh --foo',
        notice: 'sent',
      },
      deps,
      ss,
    );
    handleAgentEvent({ type: 'hook-fired', event: 'Stop', hookCommand: 'inline-cmd' }, deps, ss);
    const m1 = calls.addNotice.mock.calls[0]!.arguments[1] as string;
    const m2 = calls.addNotice.mock.calls[1]!.arguments[1] as string;
    assert.match(m1, /\(notify\.sh\) — sent/);
    assert.match(m2, /\(inline-cmd\)$/);
  });

  it('compaction-start + compaction (aggressive) clear/restore thinking and emit notices', () => {
    const { deps, calls } = fakeDeps();
    const { ss } = makeSs();
    handleAgentEvent({ type: 'compaction-start', aggressive: true }, deps, ss);
    handleAgentEvent(
      { type: 'compaction', oldMessages: 50, newMessages: 12, aggressive: true, phase: 4 },
      deps,
      ss,
    );
    assert.deepStrictEqual(calls.setCompacting.mock.calls[0]!.arguments[0], { aggressive: true });
    assert.strictEqual(calls.setCompacting.mock.calls[1]!.arguments[0], null);
    assert.match(calls.addNotice.mock.calls[0]!.arguments[1] as string, /aggressively compacting/);
    assert.match(
      calls.addNotice.mock.calls[1]!.arguments[1] as string,
      /Compacted 50 messages → 12.*aggressive pass/,
    );
    assert.strictEqual(calls.refreshTokenEstimate.mock.callCount(), 1);
  });

  it('compaction-start + compaction (non-aggressive) use the gentler labels', () => {
    const { deps, calls } = fakeDeps();
    const { ss } = makeSs();
    handleAgentEvent({ type: 'compaction-start', aggressive: false }, deps, ss);
    handleAgentEvent(
      { type: 'compaction', oldMessages: 5, newMessages: 3, aggressive: false, phase: 1 },
      deps,
      ss,
    );
    assert.match(
      calls.addNotice.mock.calls[0]!.arguments[1] as string,
      /Compacting conversation history/,
    );
    const second = calls.addNotice.mock.calls[1]!.arguments[1] as string;
    assert.match(second, /Compacted 5 messages → 3$/);
    assert.doesNotMatch(second, /aggressive/);
  });

  it('error wraps the message with an "Error:" prefix at danger level', () => {
    const { deps, calls } = fakeDeps();
    const { ss } = makeSs();
    handleAgentEvent({ type: 'error', error: new Error('kaboom') }, deps, ss);
    assert.deepStrictEqual(calls.addNotice.mock.calls[0]!.arguments, ['danger', 'Error: kaboom']);
  });
});

describe('event-handler — turn-complete', () => {
  it('records success on a "completed" turn with usage and an active key', () => {
    const { deps, calls } = fakeDeps({
      activeKeyId: 'k1',
      provider: { name: 'anthropic' },
    });
    const { ss, flags } = makeSs();
    handleAgentEvent(
      {
        type: 'turn-complete',
        stopReason: 'completed',
        turnsUsed: 2,
        usage: { totalTokens: 100, promptTokens: 50, completionTokens: 50 },
      },
      deps,
      ss,
    );
    assert.strictEqual(flags.tokenLimit, 0);
    const turnsUpdater = calls.setSessionTurns.mock.calls[0]!.arguments[0] as (n: number) => number;
    assert.strictEqual(turnsUpdater(7), 9);
    assert.deepStrictEqual(calls.setLastUsage.mock.calls[0]!.arguments[0], {
      totalTokens: 100,
      promptTokens: 50,
      completionTokens: 50,
    });
    assert.strictEqual(calls.setActivity.mock.calls[0]!.arguments[0], null);
  });

  it('marks token-limit halt without recording success', () => {
    const { deps, calls } = fakeDeps({
      activeKeyId: 'k1',
      provider: { name: 'anthropic' },
    });
    const { ss, flags } = makeSs();
    handleAgentEvent({ type: 'turn-complete', stopReason: 'token-limit', turnsUsed: 1 }, deps, ss);
    assert.strictEqual(flags.tokenLimit, 1);
    assert.strictEqual(calls.setLastUsage.mock.callCount(), 0);
  });

  it('skips key recording when there is no active key, even on completed', () => {
    const { deps, calls } = fakeDeps({ provider: { name: 'anthropic' } });
    const { ss } = makeSs();
    handleAgentEvent({ type: 'turn-complete', stopReason: 'completed', turnsUsed: 1 }, deps, ss);
    // Activity always cleared at turn boundary.
    assert.strictEqual(calls.setActivity.mock.calls[0]!.arguments[0], null);
  });
});

describe('event-handler — dispatcher', () => {
  it('returns silently when refs.current is null (run already torn down)', () => {
    const { deps, calls } = fakeDeps(null);
    const { ss } = makeSs();
    handleAgentEvent({ type: 'text-chunk', content: 'ignored' }, deps, ss);
    assert.strictEqual(calls.setStreamingText.mock.callCount(), 0);
    assert.strictEqual(calls.setThinking.mock.callCount(), 0);
  });

  it('drops unknown event types (pre-turn-stats is intentionally a no-op too)', () => {
    const { deps, calls } = fakeDeps({});
    const { ss } = makeSs();
    handleAgentEvent(
      {
        type: 'pre-turn-stats',
        tokenEstimate: 1000,
        messageCount: 5,
        percentOfWindow: 10,
      },
      deps,
      ss,
    );
    // Casting around the union to simulate a runtime event the table doesn't
    // recognize. The dispatcher should ignore it without throwing.
    handleAgentEvent({ type: 'no-such-event' } as never, deps, ss);
    assert.strictEqual(calls.addItem.mock.callCount(), 0);
    assert.strictEqual(calls.addNotice.mock.callCount(), 0);
  });
});
