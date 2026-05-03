import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { Provider, ChatMessage, ChatChunk, ToolDefinition, ProviderCapabilities } from '../../src/providers/types.js';
import type { AgentEvent, PermissionDecision } from '../../src/core/agent-types.js';
import type { ContextManager } from '../../src/core/context-manager.js';
import { Conversation } from '../../src/core/conversation.js';
import { PermissionManager } from '../../src/permissions.js';
import { defaultRegistry } from '../../src/tools/index.js';
import { runAgent } from '../../src/core/agent.js';

// ─── Mock provider ──────────────────────────────────────────────────────

interface MockResponse {
  content?: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } } | undefined>;
  /** When set, chat() throws this Error message on this queue slot (chatNoStream consumes the next slot). */
  streamError?: string;
}

function createMockProvider(responses: MockResponse[]): Provider {
  const queue = [...responses];

  return {
    name: 'mock',
    async listModels() {
      return ['mock-model'];
    },
    getCapabilities(): ProviderCapabilities {
      return {
        contextWindow: 8192,
        maxOutputTokens: 4096,
        toolSupport: 'native',
        parallelToolCalls: false,
        streaming: true,
        tokenCounting: 'estimated',
        modelTier: 'strong',
      };
    },
    async *chat(
      _model: string,
      _messages: ChatMessage[],
      _tools?: ToolDefinition[],
    ): AsyncGenerator<ChatChunk> {
      const resp = queue.shift() ?? { content: 'No mock response.' };
      if (resp.streamError) {
        throw new Error(resp.streamError);
      }
      if (resp.content) {
        // Stream word by word like the real mock server
        const words = resp.content.split(' ');
        for (const word of words) {
          yield { content: word + ' ' };
        }
      }
      if (resp.tool_calls) {
        yield { tool_calls: resp.tool_calls as any, done: true };
      } else {
        yield { done: true };
      }
    },
    async chatNoStream(
      _model: string,
      _messages: ChatMessage[],
      _tools?: ToolDefinition[],
    ): Promise<ChatChunk> {
      const resp = queue.shift() ?? { content: 'No mock response.' };
      return {
        content: resp.content,
        tool_calls: resp.tool_calls as any,
        done: true,
      };
    },
  };
}

// ─── Helper to collect events ───────────────────────────────────────────

async function collectEvents(
  input: string,
  provider: Provider,
  opts?: {
    permissions?: PermissionManager;
    maxTurns?: number;
    signal?: AbortSignal;
    onPermission?: (toolName: string) => PermissionDecision;
    enableCorrector?: boolean;
  },
): Promise<AgentEvent[]> {
  const conversation = new Conversation('You are a test assistant.');
  const permissions = opts?.permissions ?? new PermissionManager();
  const events: AgentEvent[] = [];

  const agent = runAgent(input, {
    provider,
    model: 'mock-model',
    conversation,
    permissions,
    toolRegistry: defaultRegistry,
    maxTurns: opts?.maxTurns,
    signal: opts?.signal,
    // Default off in tests so the corrector doesn't consume mock responses
    // unexpectedly. Specific corrector tests opt in.
    enableCorrector: opts?.enableCorrector ?? false,
  });

  for await (const event of agent) {
    events.push(event);
    if (event.type === 'permission-request') {
      const decision = opts?.onPermission?.(event.toolName) ?? 'allow';
      event.respond(decision);
    }
  }

  return events;
}

function findEvents(events: AgentEvent[], type: string): AgentEvent[] {
  return events.filter(e => e.type === type);
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('Agent loop', () => {
  describe('plain text response', () => {
    it('yields text chunks and turn-complete', async () => {
      const provider = createMockProvider([{ content: 'Hello world' }]);
      const events = await collectEvents('hi', provider);

      const chunks = findEvents(events, 'text-chunk');
      assert.ok(chunks.length > 0, 'should have text chunks');

      const done = findEvents(events, 'text-done');
      assert.strictEqual(done.length, 1);

      const complete = findEvents(events, 'turn-complete');
      assert.strictEqual(complete.length, 1);
      assert.strictEqual((complete[0] as any).stopReason, 'completed');
      assert.strictEqual((complete[0] as any).turnsUsed, 1);
    });

    it('assembled text matches full content', async () => {
      const provider = createMockProvider([{ content: 'Hello beautiful world' }]);
      const events = await collectEvents('hi', provider);

      const textDone = findEvents(events, 'text-done')[0] as any;
      assert.ok(textDone.fullContent.includes('Hello'));
      assert.ok(textDone.fullContent.includes('world'));
    });
  });

  describe('tool execution', () => {
    it('yields tool-call-start, permission-request, and tool-call-result', async () => {
      const provider = createMockProvider([
        {
          content: 'Let me check.',
          tool_calls: [{ function: { name: 'Bash', arguments: { command: 'echo test' } } }],
        },
        { content: 'Done.' },
      ]);

      const events = await collectEvents('run echo test', provider);

      const starts = findEvents(events, 'tool-call-start');
      assert.strictEqual(starts.length, 1);
      assert.strictEqual((starts[0] as any).toolName, 'Bash');

      const perms = findEvents(events, 'permission-request');
      assert.strictEqual(perms.length, 1);

      const results = findEvents(events, 'tool-call-result');
      assert.strictEqual(results.length, 1);
      assert.strictEqual((results[0] as any).toolName, 'Bash');
      assert.ok((results[0] as any).result.output.includes('test'));
    });

    it('yields tool-call-denied when permission is denied', async () => {
      const provider = createMockProvider([
        {
          tool_calls: [{ function: { name: 'Bash', arguments: { command: 'rm -rf /' } } }],
        },
        { content: 'OK, denied.' },
      ]);

      const events = await collectEvents('delete everything', provider, {
        onPermission: () => 'deny',
      });

      const denied = findEvents(events, 'tool-call-denied');
      assert.strictEqual(denied.length, 1);
      assert.strictEqual((denied[0] as any).toolName, 'Bash');

      // Should NOT have a tool-call-result
      const results = findEvents(events, 'tool-call-result');
      assert.strictEqual(results.length, 0);
    });

    it('auto-allows after allow-all decision', async () => {
      const provider = createMockProvider([
        {
          tool_calls: [{ function: { name: 'Bash', arguments: { command: 'echo 1' } } }],
        },
        {
          tool_calls: [{ function: { name: 'Bash', arguments: { command: 'echo 2' } } }],
        },
        { content: 'Done.' },
      ]);

      let permCount = 0;
      const events = await collectEvents('run both', provider, {
        onPermission: () => {
          permCount++;
          return 'allow-all';
        },
      });

      // Only one permission prompt (second call auto-allowed)
      assert.strictEqual(permCount, 1);

      const perms = findEvents(events, 'permission-request');
      assert.strictEqual(perms.length, 1);

      // Both tools should have executed
      const results = findEvents(events, 'tool-call-result');
      assert.strictEqual(results.length, 2);
    });
  });

  describe('unknown tool', () => {
    it('yields error for unknown tool name', async () => {
      const provider = createMockProvider([
        {
          tool_calls: [{ function: { name: 'NonExistent', arguments: {} } }],
        },
        { content: 'That tool does not exist.' },
      ]);

      const events = await collectEvents('use fake tool', provider);

      const errors = findEvents(events, 'error');
      assert.ok(errors.length > 0);
      assert.ok((errors[0] as any).error.message.includes('NonExistent'));
    });
  });

  describe('maxTurns limit', () => {
    it('stops after maxTurns consecutive tool-calling turns', async () => {
      // Create a provider that always returns tool calls
      const responses: MockResponse[] = [];
      for (let i = 0; i < 10; i++) {
        responses.push({
          tool_calls: [{ function: { name: 'Bash', arguments: { command: `echo ${i}` } } }],
        });
      }

      const permissions = new PermissionManager();
      permissions.allowAll('Bash');

      const events = await collectEvents('loop forever', createMockProvider(responses), {
        permissions,
        maxTurns: 3,
      });

      const complete = findEvents(events, 'turn-complete');
      assert.strictEqual(complete.length, 1);
      assert.strictEqual((complete[0] as any).stopReason, 'turn-limit');
      assert.strictEqual((complete[0] as any).turnsUsed, 3);
    });
  });

  describe('abort signal', () => {
    it('stops when signal is aborted before first turn', async () => {
      const controller = new AbortController();
      controller.abort();

      const provider = createMockProvider([{ content: 'Should not appear.' }]);
      const events = await collectEvents('hi', provider, { signal: controller.signal });

      const complete = findEvents(events, 'turn-complete');
      assert.strictEqual(complete.length, 1);
      assert.strictEqual((complete[0] as any).stopReason, 'user-abort');

      // No text should have been emitted
      const chunks = findEvents(events, 'text-chunk');
      assert.strictEqual(chunks.length, 0);
    });

    it('preserves partial text when aborted mid-stream', async () => {
      // Mock a provider that streams several chunks but checks the signal
      // between them — once aborted, raises AbortError partway through.
      const controller = new AbortController();
      const provider: Provider = {
        name: 'mock',
        async listModels() { return ['mock-model']; },
        getCapabilities(): ProviderCapabilities {
          return {
            contextWindow: 8192,
            maxOutputTokens: 4096,
            toolSupport: 'native',
            parallelToolCalls: false,
            streaming: true,
            tokenCounting: 'estimated',
            modelTier: 'strong',
          };
        },
        async *chat(): AsyncGenerator<ChatChunk> {
          yield { content: 'partial ' };
          yield { content: 'tree ' };
          // Simulate the user pressing Esc here.
          controller.abort();
          // The next chunk would never arrive in the real flow because the
          // abort propagates to the HTTP request — emulate by throwing.
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        },
        async chatNoStream(): Promise<ChatChunk> {
          return { content: '', done: true };
        },
      };

      const conversation = new Conversation('You are a test assistant.');
      const events: AgentEvent[] = [];
      const agent = runAgent('draw a tree', {
        provider,
        model: 'mock-model',
        conversation,
        permissions: new PermissionManager(),
        toolRegistry: defaultRegistry,
        signal: controller.signal,
        enableCorrector: false,
      });
      for await (const ev of agent) events.push(ev);

      // Partial content was committed via text-done before user-abort fired.
      const done = findEvents(events, 'text-done');
      assert.strictEqual(done.length, 1);
      assert.strictEqual((done[0] as any).fullContent, 'partial tree ');

      const complete = findEvents(events, 'turn-complete');
      assert.strictEqual(complete.length, 1);
      assert.strictEqual((complete[0] as any).stopReason, 'user-abort');

      // Conversation now contains the partial as a real assistant message.
      const msgs = conversation.getMessages();
      const lastAssistant = msgs.filter(m => m.role === 'assistant').pop();
      assert.ok(lastAssistant);
      assert.strictEqual(lastAssistant!.content, 'partial tree ');
    });
  });

  describe('conversation state', () => {
    it('adds user message to conversation', async () => {
      const conversation = new Conversation('system');
      const provider = createMockProvider([{ content: 'reply' }]);
      const permissions = new PermissionManager();

      const agent = runAgent('hello', {
        provider,
        model: 'mock',
        conversation,
        permissions,
        toolRegistry: defaultRegistry,
      });

      for await (const _ of agent) { /* drain */ }

      const msgs = conversation.getMessages();
      assert.strictEqual(msgs[1].role, 'user');
      assert.strictEqual(msgs[1].content, 'hello');
    });

    it('adds assistant message and tool results to conversation', async () => {
      const conversation = new Conversation('system');
      const permissions = new PermissionManager();
      permissions.allowAll('Bash');

      const provider = createMockProvider([
        {
          content: 'Running command.',
          tool_calls: [{ function: { name: 'Bash', arguments: { command: 'echo hi' } } }],
        },
        { content: 'Done.' },
      ]);

      const agent = runAgent('run echo', {
        provider,
        model: 'mock',
        conversation,
        permissions,
        toolRegistry: defaultRegistry,
      });

      for await (const _ of agent) { /* drain */ }

      const msgs = conversation.getMessages();
      // system, user, assistant (with tool_calls), tool (result), assistant (final)
      assert.strictEqual(msgs.length, 5);
      assert.strictEqual(msgs[2].role, 'assistant');
      assert.ok(msgs[2].tool_calls);
      assert.strictEqual(msgs[3].role, 'tool');
      assert.strictEqual(msgs[4].role, 'assistant');
    });
  });

  describe('auto-retry on tool failure', () => {
    it('injects a retry nudge when model bails after a tool failure, then recovers', async () => {
      const permissions = new PermissionManager();
      permissions.allowAll('Bash');

      const provider = createMockProvider([
        // Turn 1: model calls Bash with an invalid command (will fail).
        {
          content: '',
          tool_calls: [{ function: { name: 'Bash', arguments: {} } }],
        },
        // Turn 2: model bails to prose → triggers auto-retry nudge.
        { content: "I tried but it didn't work." },
        // Turn 3: after the retry nudge, model issues a successful Bash call.
        {
          content: '',
          tool_calls: [{ function: { name: 'Bash', arguments: { command: 'echo ok' } } }],
        },
        // Turn 4: final answer.
        { content: 'Done.' },
      ]);

      const events = await collectEvents('do something', provider, { permissions });

      const injected = findEvents(events, 'auto-retry-injected');
      assert.strictEqual(injected.length, 1, 'expected exactly one auto-retry-injected event');
      assert.strictEqual((injected[0] as any).remainingBudget, 2);
      assert.match((injected[0] as any).reason, /Bash/);

      const exhausted = findEvents(events, 'auto-retry-exhausted');
      assert.strictEqual(exhausted.length, 0, 'should not exhaust when model recovers');

      const complete = findEvents(events, 'turn-complete');
      assert.strictEqual(complete.length, 1);
      assert.strictEqual((complete[0] as any).stopReason, 'completed');
    });

    it('does NOT auto-retry when model produces prose without tool call (no real failure)', async () => {
      const provider = createMockProvider([
        // Prose response with action verbs, but no tool call. No prior failure.
        { content: "I will run npm install eslint to add linting." },
      ]);

      const events = await collectEvents('add linting', provider);

      // Action-mention auto-retry was removed — this should NOT fire.
      const injected = findEvents(events, 'auto-retry-injected');
      assert.strictEqual(injected.length, 0);
    });

    it('exhausts the retry budget when model never recovers', async () => {
      const permissions = new PermissionManager();
      permissions.allowAll('Read');

      // Each entry: failed Read → prose bail. Model never produces a successful call.
      const provider = createMockProvider([
        { content: '', tool_calls: [{ function: { name: 'Read', arguments: { file_path: '/missing-1' } } }] },
        { content: 'oops' },
        { content: '', tool_calls: [{ function: { name: 'Read', arguments: { file_path: '/missing-2' } } }] },
        { content: 'still nope' },
        { content: '', tool_calls: [{ function: { name: 'Read', arguments: { file_path: '/missing-3' } } }] },
        { content: 'giving up' },
        { content: '', tool_calls: [{ function: { name: 'Read', arguments: { file_path: '/missing-4' } } }] },
        { content: 'final' },
      ]);

      const events = await collectEvents('read missing files', provider, { permissions });

      const injected = findEvents(events, 'auto-retry-injected');
      assert.strictEqual(injected.length, 3, 'should inject up to 3 retries');

      const exhausted = findEvents(events, 'auto-retry-exhausted');
      assert.strictEqual(exhausted.length, 1);
    });
  });

  describe('all-denied halt', () => {
    it('halts the run when every tool call in a turn is denied', async () => {
      const provider = createMockProvider([
        {
          content: '',
          tool_calls: [
            { function: { name: 'Bash', arguments: { command: 'rm -rf /' } } },
            { function: { name: 'Bash', arguments: { command: 'rm -rf .' } } },
          ],
        },
        // Should never be reached because the run halts.
        { content: 'never seen' },
      ]);

      const events = await collectEvents(
        'do something dangerous',
        provider,
        { onPermission: () => 'deny' },
      );

      const halts = findEvents(events, 'all-denied-halt');
      assert.strictEqual(halts.length, 1);
      assert.strictEqual((halts[0] as any).count, 2);

      // Should not have produced a second turn or auto-retried.
      const completes = findEvents(events, 'turn-complete');
      assert.strictEqual(completes.length, 1);
      assert.strictEqual((completes[0] as any).turnsUsed, 1);
    });
  });

  describe('plan mode', () => {
    it('queues write tools instead of executing them', async () => {
      const permissions = new PermissionManager();
      permissions.allowAll('Read');
      permissions.allowAll('Edit');

      const tmpFp = path.join(os.tmpdir(), `oc-plan-${crypto.randomUUID()}.txt`);
      fs.writeFileSync(tmpFp, 'foo\n');

      try {
        const provider = createMockProvider([
          {
            content: '',
            tool_calls: [
              { function: { name: 'Read', arguments: { file_path: tmpFp } } },
            ],
          },
          {
            content: 'I will edit it.',
            tool_calls: [
              { function: { name: 'Edit', arguments: { file_path: tmpFp, old_string: 'foo', new_string: 'bar' } } },
            ],
          },
          { content: 'Plan ready.' },
        ]);

        const conversation = new Conversation('You are a test assistant.');
        const events: AgentEvent[] = [];
        const agent = runAgent('do it', {
          provider,
          model: 'mock',
          conversation,
          permissions,
          toolRegistry: defaultRegistry,
          planMode: true,
        });
        for await (const event of agent) {
          events.push(event);
          if (event.type === 'permission-request') event.respond('allow');
        }

        const planned = events.filter(e => e.type === 'tool-call-planned') as Extract<AgentEvent, { type: 'tool-call-planned' }>[];
        assert.strictEqual(planned.length, 1, 'Edit should have been queued');
        assert.strictEqual(planned[0].toolName, 'Edit');

        // Read (read-only) should still execute normally
        const reads = events.filter(e => e.type === 'tool-call-result' && e.toolName === 'Read');
        assert.strictEqual(reads.length, 1);

        // File should be untouched (only foo, not bar)
        assert.strictEqual(fs.readFileSync(tmpFp, 'utf-8'), 'foo\n');
      } finally {
        try { fs.unlinkSync(tmpFp); } catch { /* ignore */ }
      }
    });
  });

  describe('multi-turn agent loop', () => {
    it('completes a two-turn tool chain', async () => {
      const permissions = new PermissionManager();
      permissions.allowAll('Bash');
      permissions.allowAll('Read');

      const tmpFp = path.join(os.tmpdir(), `oc-multi-${crypto.randomUUID()}.txt`);
      fs.writeFileSync(tmpFp, 'hello\n');

      try {
        const provider = createMockProvider([
          {
            content: 'First I will run a command.',
            tool_calls: [{ function: { name: 'Bash', arguments: { command: 'echo step1' } } }],
          },
          {
            content: 'Now reading a file.',
            tool_calls: [{ function: { name: 'Read', arguments: { file_path: tmpFp } } }],
          },
          { content: 'All done.' },
        ]);

        const events = await collectEvents('do multi-step', provider, { permissions });

        const results = findEvents(events, 'tool-call-result');
        assert.strictEqual(results.length, 2);

        const complete = findEvents(events, 'turn-complete');
        assert.strictEqual(complete.length, 1);
        assert.strictEqual((complete[0] as any).stopReason, 'completed');
        assert.strictEqual((complete[0] as any).turnsUsed, 3);
      } finally {
        try { fs.unlinkSync(tmpFp); } catch { /* ignore */ }
      }
    });
  });

  // ─── Gap-closing tests for refactor coverage ──────────────────────────

  describe('stream-to-no-stream fallback', () => {
  it('falls back to chatNoStream when chat() throws a stream error', async () => {
      const provider = createMockProvider([
        { streamError: 'stream interrupted' },
        { content: 'recovered via fallback' },
      ]);

      const events = await collectEvents('hi', provider);

      const chunks = findEvents(events, 'text-chunk');
      assert.strictEqual(chunks.length, 1, 'fallback yields exactly one text-chunk');
      assert.strictEqual((chunks[0] as any).content, 'recovered via fallback');

      const done = findEvents(events, 'text-done');
      assert.strictEqual(done.length, 1);
      assert.strictEqual((done[0] as any).fullContent, 'recovered via fallback');

      const complete = findEvents(events, 'turn-complete');
      assert.strictEqual(complete.length, 1);
      assert.strictEqual((complete[0] as any).stopReason, 'completed');
    });
  });

  it('ignores malformed tool call entries instead of crashing the turn', async () => {
    const events = await collectEvents(
      'read the readme',
      createMockProvider([{
        tool_calls: [
          undefined,
          {
            function: {
              name: 'Read',
              arguments: { file_path: 'README.md' },
            },
          },
        ],
      }]),
    );

    const permissionRequests = findEvents(events, 'permission-request');
    assert.strictEqual(permissionRequests.length, 1);
    assert.strictEqual((permissionRequests[0] as any).toolName, 'Read');
  });

  describe('text-tool recovery', () => {
    it('recovers a tool call from <tool_call> markup when native tool_calls is empty', async () => {
      const permissions = new PermissionManager();
      permissions.allowAll('Bash');

      const provider = createMockProvider([
        { content: 'I will run echo. <tool_call>{"name":"Bash","arguments":{"command":"echo hi"}}</tool_call>' },
        { content: 'Done.' },
      ]);

      const events = await collectEvents('say hi', provider, { permissions });

      const recovered = findEvents(events, 'tool-call-recovered');
      assert.strictEqual(recovered.length, 1);
      assert.strictEqual((recovered[0] as any).count, 1);
      assert.strictEqual((recovered[0] as any).source, 'tag');

      const starts = findEvents(events, 'tool-call-start');
      assert.strictEqual(starts.length, 1);
      assert.strictEqual((starts[0] as any).toolName, 'Bash');

      const results = findEvents(events, 'tool-call-result');
      assert.strictEqual(results.length, 1);
      assert.ok((results[0] as any).result.output.includes('hi'));
    });
  });

  describe('tool-result-imitation stripping', () => {
    it('strips imitated TOOL_RESULT blocks and yields the strip count', async () => {
      const provider = createMockProvider([
        { content: 'before <<TOOL_RESULT name="Bash">>fake<<END_TOOL_RESULT>> after' },
      ]);

      const events = await collectEvents('hi', provider);

      const stripped = findEvents(events, 'tool-result-imitation-stripped');
      assert.strictEqual(stripped.length, 1);
      assert.strictEqual((stripped[0] as any).count, 1);
    });
  });

  describe('corrector integration', () => {
    it('invokes the corrector after a tool failure and runs the corrected call', async () => {
      const permissions = new PermissionManager();
      permissions.allowAll('Read');

      const tmpFp = path.join(os.tmpdir(), `oc-corr-${crypto.randomUUID()}.txt`);
      fs.writeFileSync(tmpFp, 'corrected file content');

      try {
        const provider = createMockProvider([
          // Turn 1: model emits a Read on a missing file (will fail).
          { tool_calls: [{ function: { name: 'Read', arguments: { file_path: '/definitely-does-not-exist-zzz' } } }] },
          // Corrector chatNoStream: returns JSON proposing a corrected Read.
          { content: `{"name":"Read","arguments":{"file_path":${JSON.stringify(tmpFp)}}}` },
          // Turn 2: model wraps up.
          { content: 'Done.' },
        ]);

        const events = await collectEvents('read it', provider, {
          permissions,
          enableCorrector: true,
        });

        const corrected = findEvents(events, 'tool-call-corrected');
        assert.strictEqual(corrected.length, 1, 'expected one tool-call-corrected event');

        const results = findEvents(events, 'tool-call-result');
        // First call fails, second call (corrected) succeeds.
        assert.strictEqual(results.length, 2);
        assert.strictEqual((results[0] as any).result.success, false);
        assert.strictEqual((results[1] as any).result.success, true);
        assert.ok((results[1] as any).result.output.includes('corrected file content'));

        const complete = findEvents(events, 'turn-complete');
        assert.strictEqual(complete.length, 1);
        assert.strictEqual((complete[0] as any).stopReason, 'completed');
      } finally {
        try { fs.unlinkSync(tmpFp); } catch { /* ignore */ }
      }
    });
  });

  describe('compaction', () => {
    it('yields a compaction event when ContextManager.shouldCompact is true', async () => {
      const cm = {
        updateUsage: () => {},
        shouldCompact: () => true,
        compact: async () => ({ oldCount: 5, newCount: 2 }),
        getUsagePercent: () => 0.5,
        getTokenEstimate: () => 100,
      } as unknown as ContextManager;

      const provider = createMockProvider([{ content: 'hi' }]);
      const conversation = new Conversation('system');
      const permissions = new PermissionManager();

      const events: AgentEvent[] = [];
      const agent = runAgent('hello', {
        provider,
        model: 'mock',
        conversation,
        permissions,
        toolRegistry: defaultRegistry,
        contextManager: cm,
        enableCorrector: false,
      });
      for await (const ev of agent) events.push(ev);

      const compactions = findEvents(events, 'compaction');
      assert.strictEqual(compactions.length, 1);
      assert.strictEqual((compactions[0] as any).oldMessages, 5);
      assert.strictEqual((compactions[0] as any).newMessages, 2);

      const complete = findEvents(events, 'turn-complete');
      assert.strictEqual((complete[0] as any).stopReason, 'completed');
    });

    it('halts with token-limit when usage stays above 0.9 after compaction', async () => {
      const cm = {
        updateUsage: () => {},
        shouldCompact: () => true,
        compact: async () => ({ oldCount: 5, newCount: 2 }),
        getUsagePercent: () => 0.95,
        getTokenEstimate: () => 100,
      } as unknown as ContextManager;

      const provider = createMockProvider([{ content: 'hi' }]);
      const conversation = new Conversation('system');
      const permissions = new PermissionManager();

      const events: AgentEvent[] = [];
      const agent = runAgent('hello', {
        provider,
        model: 'mock',
        conversation,
        permissions,
        toolRegistry: defaultRegistry,
        contextManager: cm,
        enableCorrector: false,
      });
      for await (const ev of agent) events.push(ev);

      const compactions = findEvents(events, 'compaction');
      assert.strictEqual(compactions.length, 1);

      const complete = findEvents(events, 'turn-complete');
      assert.strictEqual(complete.length, 1);
      assert.strictEqual((complete[0] as any).stopReason, 'token-limit');
    });

    it('escalates to aggressive compaction when normal pass leaves usage above 0.9', async () => {
      // Normal compact frees some space but not enough; aggressive (recencyWindow=0,
      // mechanical-only) brings usage back under the hard ceiling.
      const compactCalls: Array<{ aggressive: boolean }> = [];
      let usagePercent = 0.95;

      const cm = {
        updateUsage: () => {},
        shouldCompact: () => true,
        compact: async (
          _provider: unknown,
          _model: unknown,
          _signal: unknown,
          opts?: { aggressive?: boolean },
        ) => {
          const aggressive = opts?.aggressive ?? false;
          compactCalls.push({ aggressive });
          if (aggressive) {
            usagePercent = 0.4;
            return { oldCount: 8, newCount: 2 };
          }
          // Normal pass returned but didn't free enough.
          usagePercent = 0.92;
          return { oldCount: 30, newCount: 8 };
        },
        getUsagePercent: () => usagePercent,
        getTokenEstimate: () => 100,
      } as unknown as ContextManager;

      const provider = createMockProvider([{ content: 'all good' }]);
      const conversation = new Conversation('system');
      const permissions = new PermissionManager();

      const events: AgentEvent[] = [];
      const agent = runAgent('hello', {
        provider,
        model: 'mock',
        conversation,
        permissions,
        toolRegistry: defaultRegistry,
        contextManager: cm,
        enableCorrector: false,
      });
      for await (const ev of agent) events.push(ev);

      // Both passes ran, in the right order, with the right flags.
      assert.deepStrictEqual(compactCalls, [{ aggressive: false }, { aggressive: true }]);

      // One cumulative compaction event reports old from the first pass and new from the last.
      const compactions = findEvents(events, 'compaction');
      assert.strictEqual(compactions.length, 1);
      assert.strictEqual((compactions[0] as any).oldMessages, 30);
      assert.strictEqual((compactions[0] as any).newMessages, 2);

      // Aggressive pass freed enough room — turn completes and the model gets called.
      const complete = findEvents(events, 'turn-complete');
      assert.strictEqual(complete.length, 1);
      assert.strictEqual((complete[0] as any).stopReason, 'completed');

      const done = findEvents(events, 'text-done');
      assert.strictEqual(done.length, 1);
      assert.strictEqual((done[0] as any).fullContent.trim(), 'all good');
    });

    it('yields user-abort when AbortError propagates out of compaction', async () => {
      // Simulates ESC during the compaction summary call: chatNoStream throws
      // AbortError → compact() re-throws it → agent loop catches it → user-abort
      // (NOT mechanical-summary fallback that silently completes against intent).
      let chatCalled = false;
      const provider: Provider = {
        name: 'mock',
        async listModels() { return ['mock-model']; },
        getCapabilities(): ProviderCapabilities {
          return {
            contextWindow: 8192,
            maxOutputTokens: 4096,
            toolSupport: 'native',
            parallelToolCalls: false,
            streaming: true,
            tokenCounting: 'estimated',
            modelTier: 'strong',
          };
        },
        async *chat(): AsyncGenerator<ChatChunk> {
          chatCalled = true;
          yield { content: 'should never run', done: true };
        },
        async chatNoStream(): Promise<ChatChunk> {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        },
      };

      // Real ContextManager so compact() actually runs the chatNoStream path
      // and we exercise the catch block.
      const conversation = new Conversation('system');
      conversation.addUser('one'); conversation.addAssistant('two');
      conversation.addUser('three'); conversation.addAssistant('four');
      conversation.addUser('five'); conversation.addAssistant('six');
      conversation.addUser('seven'); conversation.addAssistant('eight');
      conversation.addUser('nine'); conversation.addAssistant('ten');
      const { ContextManager } = await import('../../src/core/context-manager.js');
      const cm = new ContextManager(conversation, provider.getCapabilities('mock-model'), {
        compactionThreshold: 0.0001, // force shouldCompact=true
        recencyWindow: 2,
      });

      const permissions = new PermissionManager();
      const events: AgentEvent[] = [];
      const agent = runAgent('hello', {
        provider,
        model: 'mock-model',
        conversation,
        permissions,
        toolRegistry: defaultRegistry,
        contextManager: cm,
        enableCorrector: false,
      });
      for await (const ev of agent) events.push(ev);

      // The model never got called because compaction aborted first.
      assert.strictEqual(chatCalled, false);

      const complete = findEvents(events, 'turn-complete');
      assert.strictEqual(complete.length, 1);
      assert.strictEqual((complete[0] as any).stopReason, 'user-abort');

      // No compaction event should have been emitted because compact() threw
      // before mutating the conversation.
      const compactions = findEvents(events, 'compaction');
      assert.strictEqual(compactions.length, 0);
    });

    it('halts with token-limit when even aggressive compaction can\'t free enough', async () => {
      const compactCalls: Array<{ aggressive: boolean }> = [];

      const cm = {
        updateUsage: () => {},
        shouldCompact: () => true,
        compact: async (
          _provider: unknown,
          _model: unknown,
          _signal: unknown,
          opts?: { aggressive?: boolean },
        ) => {
          compactCalls.push({ aggressive: opts?.aggressive ?? false });
          return { oldCount: 5, newCount: 3 };
        },
        // Stays pinned above the hard ceiling regardless of compaction.
        getUsagePercent: () => 0.97,
        getTokenEstimate: () => 100,
      } as unknown as ContextManager;

      const provider = createMockProvider([{ content: 'never seen' }]);
      const conversation = new Conversation('system');
      const permissions = new PermissionManager();

      const events: AgentEvent[] = [];
      const agent = runAgent('hello', {
        provider,
        model: 'mock',
        conversation,
        permissions,
        toolRegistry: defaultRegistry,
        contextManager: cm,
        enableCorrector: false,
      });
      for await (const ev of agent) events.push(ev);

      // Both passes ran before halting.
      assert.deepStrictEqual(compactCalls, [{ aggressive: false }, { aggressive: true }]);

      const complete = findEvents(events, 'turn-complete');
      assert.strictEqual(complete.length, 1);
      assert.strictEqual((complete[0] as any).stopReason, 'token-limit');

      // Halt happened before the model was called — no streamed text.
      const chunks = findEvents(events, 'text-chunk');
      assert.strictEqual(chunks.length, 0);
    });
  });
});
