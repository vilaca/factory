import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { AgentEvent } from '../../../../src/core/agent/types.js';
import { Conversation } from '../../../../src/core/context/conversation.js';
import { PermissionManager } from '../../../../src/security/permissions.js';
import { defaultRegistry } from '../../../../src/tools/index.js';
import { runAgent } from '../../../../src/core/agent/run-agent.js';
import { createMockProvider, collectEvents, findEvents } from './agent-helpers.js';

describe('Agent loop — auto-retry on tool failure', () => {
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
      { content: 'I will run npm install eslint to add linting.' },
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
      {
        content: '',
        tool_calls: [{ function: { name: 'Read', arguments: { file_path: '/missing-1' } } }],
      },
      { content: 'oops' },
      {
        content: '',
        tool_calls: [{ function: { name: 'Read', arguments: { file_path: '/missing-2' } } }],
      },
      { content: 'still nope' },
      {
        content: '',
        tool_calls: [{ function: { name: 'Read', arguments: { file_path: '/missing-3' } } }],
      },
      { content: 'giving up' },
      {
        content: '',
        tool_calls: [{ function: { name: 'Read', arguments: { file_path: '/missing-4' } } }],
      },
      { content: 'final' },
    ]);

    const events = await collectEvents('read missing files', provider, { permissions });

    const injected = findEvents(events, 'auto-retry-injected');
    assert.strictEqual(injected.length, 3, 'should inject up to 3 retries');

    const exhausted = findEvents(events, 'auto-retry-exhausted');
    assert.strictEqual(exhausted.length, 1);
  });
});

describe('Agent loop — all-denied halt', () => {
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

    const events = await collectEvents('do something dangerous', provider, {
      onPermission: () => 'deny',
    });

    const halts = findEvents(events, 'all-denied-halt');
    assert.strictEqual(halts.length, 1);
    assert.strictEqual((halts[0] as any).count, 2);

    // Should not have produced a second turn or auto-retried.
    const completes = findEvents(events, 'turn-complete');
    assert.strictEqual(completes.length, 1);
    assert.strictEqual((completes[0] as any).turnsUsed, 1);
  });
});

describe('Agent loop — plan mode', () => {
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
          tool_calls: [{ function: { name: 'Read', arguments: { file_path: tmpFp } } }],
        },
        {
          content: 'I will edit it.',
          tool_calls: [
            {
              function: {
                name: 'Edit',
                arguments: { file_path: tmpFp, old_string: 'foo', new_string: 'bar' },
              },
            },
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

      const planned = events.filter(e => e.type === 'tool-call-planned') as Extract<
        AgentEvent,
        { type: 'tool-call-planned' }
      >[];
      assert.strictEqual(planned.length, 1, 'Edit should have been queued');
      assert.strictEqual(planned[0].toolName, 'Edit');

      // Read (read-only) should still execute normally
      const reads = events.filter(e => e.type === 'tool-call-result' && e.toolName === 'Read');
      assert.strictEqual(reads.length, 1);

      // File should be untouched (only foo, not bar)
      assert.strictEqual(fs.readFileSync(tmpFp, 'utf-8'), 'foo\n');
    } finally {
      try {
        fs.unlinkSync(tmpFp);
      } catch {
        /* ignore */
      }
    }
  });
});

describe('Agent loop — text-tool recovery', () => {
  it('recovers a tool call from <tool_call> markup when native tool_calls is empty', async () => {
    const permissions = new PermissionManager();
    permissions.allowAll('Bash');

    const provider = createMockProvider([
      {
        content:
          'I will run echo. <tool_call>{"name":"Bash","arguments":{"command":"echo hi"}}</tool_call>',
      },
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

describe('Agent loop — tool-result-imitation stripping', () => {
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
