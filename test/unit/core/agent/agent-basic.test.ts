import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { Provider, ChatChunk, ProviderCapabilities } from '../../../../src/providers/types.js';
import type { AgentEvent } from '../../../../src/core/agent/types.js';
import { Conversation } from '../../../../src/core/context/conversation.js';
import { PermissionManager } from '../../../../src/security/permissions.js';
import { defaultRegistry } from '../../../../src/tools/index.js';
import { runAgent } from '../../../../src/core/agent/run-agent.js';
import { createMockProvider, collectEvents, findEvents } from './agent-helpers.js';

describe('Agent loop — plain text response', () => {
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

describe('Agent loop — tool execution', () => {
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

describe('Agent loop — unknown tool', () => {
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

describe('Agent loop — abort signal', () => {
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

describe('Agent loop — conversation state', () => {
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

    for await (const _ of agent) {
      /* drain */
    }

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

    for await (const _ of agent) {
      /* drain */
    }

    const msgs = conversation.getMessages();
    // system, user, assistant (with tool_calls), tool (result), assistant (final)
    assert.strictEqual(msgs.length, 5);
    assert.strictEqual(msgs[2].role, 'assistant');
    assert.ok(msgs[2].tool_calls);
    assert.strictEqual(msgs[3].role, 'tool');
    assert.strictEqual(msgs[4].role, 'assistant');
  });
});

describe('Agent loop — multi-turn', () => {
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
      try {
        fs.unlinkSync(tmpFp);
      } catch {
        /* ignore */
      }
    }
  });
});

describe('Agent loop — stream-to-no-stream fallback', () => {
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

describe('Agent loop — malformed tool call entries', () => {
  it('ignores malformed tool call entries instead of crashing the turn', async () => {
    const events = await collectEvents(
      'read the readme',
      createMockProvider([
        {
          tool_calls: [
            undefined,
            {
              function: {
                name: 'Read',
                arguments: { file_path: 'README.md' },
              },
            },
          ],
        },
      ]),
    );

    const permissionRequests = findEvents(events, 'permission-request');
    assert.strictEqual(permissionRequests.length, 1);
    assert.strictEqual((permissionRequests[0] as any).toolName, 'Read');
  });
});
