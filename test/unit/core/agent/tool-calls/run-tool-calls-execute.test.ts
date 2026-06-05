import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ToolCallMessage } from '../../../../../src/providers/types.js';
import type { ToolResult } from '../../../../../src/tools/types.js';
import { Conversation } from '../../../../../src/core/context/conversation.js';
import { PermissionManager } from '../../../../../src/security/permissions.js';
import { executeToolCall } from '../../../../../src/core/agent/tool-calls/run-tool-calls-execute.js';
import {
  callOf,
  collect,
  fakeBashTool,
  fakeTool,
  makeCtx,
  makeRegistry,
} from './run-tool-calls-fixtures.js';

const tc = (name: string, args: Record<string, unknown> = {}, id = 'tc'): ToolCallMessage =>
  callOf(name, args, id);

describe('executeToolCall — input shape', () => {
  it('records an error and returns when fnName is missing', async () => {
    const conv = new Conversation('sys');
    const ctx = makeCtx({ conversation: conv });
    const { events } = await collect(
      executeToolCall({ id: 'x', function: { name: '', arguments: {} } } as ToolCallMessage, ctx),
    );
    assert.deepStrictEqual(events, []);
    const last = conv.getMessages().at(-1)!;
    assert.strictEqual(last.role, 'tool');
    assert.match(last.content, /missing function name/);
  });

  it('emits an error event for an unknown tool', async () => {
    const ctx = makeCtx({ toolRegistry: makeRegistry([]) });
    const { events } = await collect(executeToolCall(tc('Nope'), ctx));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]!.type, 'error');
    if (events[0]!.type === 'error') {
      assert.match(events[0].error.message, /unknown tool/);
    }
  });
});

describe('executeToolCall — schema validation', () => {
  // A tool with a real JSON Schema — strict enough to reject the "missing
  // required field" and "wrong type" cases without touching tool internals.
  // Mirrors the shape src/tools/read.ts declares.
  const schemaToolBuilder = () => {
    const calls: Record<string, unknown>[] = [];
    const handler = {
      name: 'Strict',
      description: 'fake',
      category: 'read-only' as const,
      definition: {
        type: 'function' as const,
        function: {
          name: 'Strict',
          description: 'fake',
          parameters: {
            type: 'object',
            required: ['file_path'],
            properties: {
              file_path: { type: 'string' },
              offset: { type: 'number' },
            },
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        calls.push(args);
        return { success: true, output: 'ok' };
      },
    };
    return Object.assign(handler, { calls });
  };

  it('rejects bad args before the tool runs and never prompts for permission', async () => {
    const tool = schemaToolBuilder();
    const conv = new Conversation('sys');
    const ctx = makeCtx({ conversation: conv, toolRegistry: makeRegistry([tool]) });
    const { events } = await collect(executeToolCall(tc('Strict', {}), ctx));
    assert.strictEqual(tool.calls.length, 0);
    assert.ok(!events.some(e => e.type === 'permission-request'));

    const result = events.find(e => e.type === 'tool-call-result');
    assert.ok(result && result.type === 'tool-call-result');
    assert.strictEqual(result.result.success, false);
    assert.strictEqual(result.result.softError, true);
    assert.strictEqual(result.result.skipCorrector, true);
    assert.match(result.result.output, /Invalid arguments for "Strict"/);
    assert.match(result.result.output, /missing required field "file_path"/);
  });

  it('emits tool-call-start before the failure so the UI start/result pair stays balanced', async () => {
    const tool = schemaToolBuilder();
    const ctx = makeCtx({ toolRegistry: makeRegistry([tool]) });
    const { events } = await collect(executeToolCall(tc('Strict', { file_path: 7 }), ctx));
    const types = events.map(e => e.type);
    assert.deepStrictEqual(types, ['tool-call-start', 'tool-call-result']);
    const result = events[1]!;
    assert.strictEqual(result.type, 'tool-call-result');
    if (result.type === 'tool-call-result') {
      assert.match(result.result.output, /file_path must be a string/);
    }
  });

  it('lets a valid call proceed normally through the permission gate', async () => {
    const tool = schemaToolBuilder();
    const ctx = makeCtx({ toolRegistry: makeRegistry([tool]) });
    const { events } = await collect(
      executeToolCall(tc('Strict', { file_path: '/etc/hosts' }), ctx),
    );
    assert.strictEqual(tool.calls.length, 1);
    assert.ok(events.some(e => e.type === 'permission-request'));
    assert.ok(events.some(e => e.type === 'tool-call-result'));
  });

  it('skips validation silently when the tool declares an empty schema (fakeTool default)', async () => {
    // fakeTool produces `parameters: {}` — malformed by our validator's
    // standards. The validator is forgiving by design (MCP tools may bring
    // arbitrary shapes), so the call should pass through to permission.
    const tool = fakeTool({ name: 'Open' });
    const ctx = makeCtx({ toolRegistry: makeRegistry([tool]) });
    const { events } = await collect(executeToolCall(tc('Open', { whatever: 1 }), ctx));
    assert.strictEqual(tool.calls.length, 1);
    assert.ok(events.some(e => e.type === 'permission-request'));
  });
});

describe('executeToolCall — plan mode', () => {
  it('queues a write tool without executing', async () => {
    const tool = fakeTool({ name: 'Write', category: 'write' });
    const ctx = makeCtx({ planMode: true, toolRegistry: makeRegistry([tool]) });
    const { events } = await collect(executeToolCall(tc('Write', { x: 1 }), ctx));
    assert.strictEqual(tool.calls.length, 0);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]!.type, 'tool-call-planned');
  });

  it('runs a read-only tool through plan mode', async () => {
    const tool = fakeTool({ name: 'Read', category: 'read-only' });
    const ctx = makeCtx({ planMode: true, toolRegistry: makeRegistry([tool]) });
    const { events } = await collect(executeToolCall(tc('Read'), ctx));
    assert.strictEqual(tool.calls.length, 1);
    assert.ok(events.some(e => e.type === 'tool-call-result'));
  });
});

describe('executeToolCall — permission gating', () => {
  it('runs after explicit allow', async () => {
    const tool = fakeTool({ name: 'Read' });
    const ctx = makeCtx({ toolRegistry: makeRegistry([tool]) });
    const { events } = await collect(executeToolCall(tc('Read'), ctx));
    const types = events.map(e => e.type);
    assert.deepStrictEqual(types, ['tool-call-start', 'permission-request', 'tool-call-result']);
  });

  it('skips permission prompting when host marks the call as framework-owned', async () => {
    const tool = fakeTool({ name: 'Read' });
    const ctx = makeCtx({ toolRegistry: makeRegistry([tool]) });
    const { events } = await collect(
      executeToolCall(tc('Read', { file_path: '/repo/AGENTS.md' }), ctx, {
        skipPermissionCheck: true,
      }),
    );
    assert.strictEqual(tool.calls.length, 1);
    assert.ok(!events.some(e => e.type === 'permission-request'));
    assert.ok(events.some(e => e.type === 'tool-call-result'));
  });

  it('allow-all marks the tool auto-allowed for subsequent calls', async () => {
    const tool = fakeTool({ name: 'Read' });
    const permissions = new PermissionManager();
    const ctx = makeCtx({ permissions, toolRegistry: makeRegistry([tool]) });

    await collect(executeToolCall(tc('Read'), ctx), { onPermission: () => 'allow-all' });
    assert.ok(permissions.isAutoAllowed('Read'));

    const { events } = await collect(executeToolCall(tc('Read'), ctx));
    assert.ok(!events.some(e => e.type === 'permission-request'));
  });

  it('records denial and emits tool-call-denied on deny', async () => {
    const tool = fakeTool({ name: 'Read' });
    const conv = new Conversation('sys');
    const ctx = makeCtx({ conversation: conv, toolRegistry: makeRegistry([tool]) });
    const { events } = await collect(executeToolCall(tc('Read'), ctx), {
      onPermission: () => 'deny',
    });
    assert.strictEqual(tool.calls.length, 0);
    assert.ok(events.some(e => e.type === 'tool-call-denied'));
    assert.match(conv.getMessages().at(-1)!.content, /denied by the user/);
  });

  it('aborts cleanly mid-permission and removes the abort listener', async () => {
    const tool = fakeTool({ name: 'Read' });
    const controller = new AbortController();
    const conv = new Conversation('sys');
    const ctx = makeCtx({
      conversation: conv,
      signal: controller.signal,
      toolRegistry: makeRegistry([tool]),
    });
    const gen = executeToolCall(tc('Read'), ctx);
    const first = await gen.next();
    assert.strictEqual(first.value!.type, 'tool-call-start');
    const second = await gen.next();
    assert.strictEqual(second.value!.type, 'permission-request');
    controller.abort();
    const third = await gen.next();
    assert.strictEqual(third.done, true);
    assert.strictEqual(tool.calls.length, 0);
    // Abort path does not append a denial message — only stops.
    assert.strictEqual(conv.messageCount(), 0);
    // Listener removed; abort() didn't leak a still-attached listener with
    // strong refs to the now-finished generator. Hard to assert directly
    // without internals, but a follow-up abort must be a no-op:
    controller.abort();
  });
});

describe('executeToolCall — Bash policy', () => {
  it('hard-denies a forbidden command without prompting', async () => {
    const tool = fakeTool({ name: 'Bash' });
    const ctx = makeCtx({ toolRegistry: makeRegistry([tool]) });
    const { events } = await collect(executeToolCall(tc('Bash', { command: 'rm -rf /' }), ctx));
    assert.strictEqual(tool.calls.length, 0);
    assert.ok(!events.some(e => e.type === 'permission-request'));
    assert.ok(events.some(e => e.type === 'tool-call-denied'));
  });

  it('runs without prompting when a user rule pre-allows the command', async () => {
    const tool = fakeTool({ name: 'Bash' });
    const permissions = new PermissionManager();
    permissions.setBashRules([{ pattern: 'echo *', decision: 'allow' }]);
    const ctx = makeCtx({ permissions, toolRegistry: makeRegistry([tool]) });
    const { events } = await collect(executeToolCall(tc('Bash', { command: 'echo hi' }), ctx));
    assert.strictEqual(tool.calls.length, 1);
    assert.ok(!events.some(e => e.type === 'permission-request'));
    assert.ok(events.some(e => e.type === 'tool-call-result'));
  });

  it("falls through to the standard permission prompt when policy says 'prompt'", async () => {
    const tool = fakeTool({ name: 'Bash' });
    const ctx = makeCtx({ toolRegistry: makeRegistry([tool]) });
    const { events } = await collect(executeToolCall(tc('Bash', { command: 'ls' }), ctx));
    assert.ok(events.some(e => e.type === 'permission-request'));
    assert.strictEqual(tool.calls.length, 1);
  });
});

describe('executeToolCall — WebFetch domain', () => {
  it('skips the prompt when the hostname is pre-allowed', async () => {
    const tool = fakeTool({ name: 'WebFetch' });
    const permissions = new PermissionManager();
    permissions.allowDomain('example.com');
    const ctx = makeCtx({ permissions, toolRegistry: makeRegistry([tool]) });
    const { events } = await collect(
      executeToolCall(tc('WebFetch', { url: 'https://example.com/x' }), ctx),
    );
    assert.ok(!events.some(e => e.type === 'permission-request'));
    assert.strictEqual(tool.calls.length, 1);
  });

  it('persists allow-domain decisions back to PermissionManager', async () => {
    const tool = fakeTool({ name: 'WebFetch' });
    const permissions = new PermissionManager();
    const ctx = makeCtx({ permissions, toolRegistry: makeRegistry([tool]) });
    await collect(executeToolCall(tc('WebFetch', { url: 'https://docs.example.com/x' }), ctx), {
      onPermission: () => 'allow-domain',
    });
    assert.ok(permissions.isDomainAllowed('docs.example.com'));
  });

  it('denies a malformed URL at the policy gate (fail-closed)', async () => {
    // Previously the gate funnelled parse failures into pre-allow and let
    // the tool's own validation produce the error. That's a fail-open path
    // — if the two parsers ever diverge, an attacker-controlled URL that
    // parses in the tool but not here would skip the prompt. Deny here.
    const tool = fakeTool({
      name: 'WebFetch',
      execute: () => ({ success: false, output: 'tool ran (should not happen)' }),
    });
    const ctx = makeCtx({ toolRegistry: makeRegistry([tool]) });
    const { events } = await collect(
      executeToolCall(tc('WebFetch', { url: '::not-a-url::' }), ctx),
    );
    assert.ok(!events.some(e => e.type === 'permission-request'));
    assert.ok(events.some(e => e.type === 'tool-call-denied'));
    assert.strictEqual(tool.calls.length, 0);
  });
});

describe('executeToolCall — execution', () => {
  it('emits tool-call-result with success=false when execute throws', async () => {
    const tool = fakeTool({
      name: 'Read',
      execute: () => {
        throw new Error('boom');
      },
    });
    const ctx = makeCtx({ toolRegistry: makeRegistry([tool]) });
    const { events } = await collect(executeToolCall(tc('Read'), ctx));
    const result = events.find(e => e.type === 'tool-call-result');
    assert.ok(result && result.type === 'tool-call-result');
    assert.strictEqual(result.result.success, false);
    assert.match(result.result.output, /boom/);
  });

  it('propagates cwdAfter from Bash into ctx.cwdRef', async () => {
    // Uses fakeBashTool — the type system forbids non-Bash handlers
    // from returning `cwdAfter`, so a plain fakeTool would not compile
    // here. That compile-time guarantee is the Pattern 2 lift.
    const tool = fakeBashTool({
      execute: () => ({ success: true, output: 'ok', cwdAfter: '/tmp/new' }),
    });
    const permissions = new PermissionManager();
    permissions.setBashRules([{ pattern: '*', decision: 'allow' }]);
    const cwdRef = { current: '/tmp/old' };
    const ctx = makeCtx({ permissions, toolRegistry: makeRegistry([tool]), cwdRef });
    await collect(executeToolCall(tc('Bash', { command: 'cd /tmp/new' }), ctx));
    assert.strictEqual(cwdRef.current, '/tmp/new');
  });

  it('records as a user message when useUserResultFraming is true', async () => {
    const tool = fakeTool({ name: 'Read' });
    const conv = new Conversation('sys');
    const ctx = makeCtx({
      conversation: conv,
      toolRegistry: makeRegistry([tool]),
      useUserResultFraming: true,
    });
    await collect(executeToolCall(tc('Read'), ctx));
    const last = conv.getMessages().at(-1)!;
    assert.strictEqual(last.role, 'user');
  });

  it('replaceLastToolResult overwrites the most recent tool message instead of appending', async () => {
    const tool = fakeTool({ name: 'Read', execute: () => ({ success: true, output: 'NEW' }) });
    const conv = new Conversation('sys');
    conv.addToolResult('OLD', 'tc', 'Read');
    const ctx = makeCtx({ conversation: conv, toolRegistry: makeRegistry([tool]) });
    await collect(
      executeToolCall(tc('Read'), ctx, { replaceLastToolResult: true, outputPrefix: '[fix] ' }),
    );
    const toolMessages = conv.getMessages().filter(m => m.role === 'tool');
    assert.strictEqual(toolMessages.length, 1, 'exactly one tool result, not appended');
    assert.match(toolMessages[0]!.content, /^\[fix\] NEW$/);
  });
});
