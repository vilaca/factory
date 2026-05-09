import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Conversation } from '../../../../../src/core/context/conversation.js';
import { PermissionManager } from '../../../../../src/security/permissions.js';
import { FileCache } from '../../../../../src/core/agent/cache/file-cache.js';
import { BashDedupTracker } from '../../../../../src/core/agent/tool-calls/bash-dedup.js';
import { runToolCalls } from '../../../../../src/core/agent/tool-calls/run-tool-calls.js';
import {
  callOf,
  collect,
  fakeTool,
  makeCtx,
  makeProvider,
  makeRecovery,
  makeRegistry,
} from './run-tool-calls-fixtures.js';

const tmp = (): string =>
  path.join(os.tmpdir(), `oc-rtc-${Date.now()}-${Math.random().toString(36).slice(2)}`);

describe('runToolCalls — abort handling', () => {
  it('throws AbortError immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = fakeTool({ name: 'Read' });
    const ctx = makeCtx({ signal: controller.signal, toolRegistry: makeRegistry([tool]) });
    await assert.rejects(
      () => collect(runToolCalls([callOf('Read')], ctx, 'sig', makeRecovery())),
      (err: Error) => err.name === 'AbortError',
    );
  });
});

describe('runToolCalls — read-cache short-circuit', () => {
  it('returns a synthetic hit instead of executing Read when fingerprint matches', async () => {
    const fp = tmp();
    await fs.writeFile(fp, 'hello');
    try {
      const cache = new FileCache();
      const stamp = await FileCache.stamp(fp);
      assert.ok(stamp);
      cache.record(fp, stamp!);

      // Tool is registered but should NOT be called — cache short-circuits before execute.
      const readTool = fakeTool({ name: 'Read' });
      const ctx = makeCtx({
        toolRegistry: makeRegistry([readTool]),
        fileCache: cache,
      });
      const { events } = await collect(
        runToolCalls([callOf('Read', { file_path: fp })], ctx, 'sig', makeRecovery()),
      );
      assert.strictEqual(readTool.calls.length, 0);
      assert.ok(events.some(e => e.type === 'read-cache-hit'));
    } finally {
      await fs.unlink(fp).catch(() => undefined);
    }
  });

  it('falls through to a real read when fingerprint mismatches', async () => {
    const fp = tmp();
    await fs.writeFile(fp, 'hello');
    try {
      const cache = new FileCache();
      cache.record(fp, { mtimeMs: 0, size: 1, hash: 'stale' });
      const readTool = fakeTool({ name: 'Read' });
      const permissions = new PermissionManager();
      permissions.allowAll('Read');
      const ctx = makeCtx({
        permissions,
        toolRegistry: makeRegistry([readTool]),
        fileCache: cache,
      });
      await collect(runToolCalls([callOf('Read', { file_path: fp })], ctx, 'sig', makeRecovery()));
      assert.strictEqual(readTool.calls.length, 1);
    } finally {
      await fs.unlink(fp).catch(() => undefined);
    }
  });
});

describe('runToolCalls — recovery state', () => {
  it('clears recovery on success and sets it on failure', async () => {
    const tool = fakeTool({
      name: 'Read',
      execute: () => ({ success: false, output: 'nope' }),
    });
    const permissions = new PermissionManager();
    permissions.allowAll('Read');
    const ctx = makeCtx({ permissions, toolRegistry: makeRegistry([tool]) });
    const recovery = makeRecovery();
    recovery.lastFailureMessage = 'old';
    recovery.consecutiveSameFailures = 5;

    await collect(runToolCalls([callOf('Read')], ctx, 'sig-fail', recovery));
    assert.strictEqual(recovery.lastFailureSignature, 'sig-fail');
    assert.match(recovery.lastFailureMessage ?? '', /nope/);

    // Now a success clears it.
    const successTool = fakeTool({ name: 'Glob' });
    const ctx2 = makeCtx({
      permissions,
      toolRegistry: makeRegistry([successTool]),
    });
    permissions.allowAll('Glob');
    await collect(runToolCalls([callOf('Glob')], ctx2, 'sig-ok', recovery));
    assert.strictEqual(recovery.lastFailureMessage, null);
    assert.strictEqual(recovery.lastFailureSignature, null);
    assert.strictEqual(recovery.consecutiveSameFailures, 0);
  });

  it('counts denials in the returned deniedCount', async () => {
    const tool = fakeTool({ name: 'Read' });
    const ctx = makeCtx({ toolRegistry: makeRegistry([tool]) });
    const { result } = await collect(runToolCalls([callOf('Read')], ctx, 'sig', makeRecovery()), {
      onPermission: () => 'deny',
    });
    assert.strictEqual(result.deniedCount, 1);
  });
});

describe('runToolCalls — file cache maintenance', () => {
  it('records a fingerprint after a successful Read', async () => {
    const fp = tmp();
    await fs.writeFile(fp, 'data');
    try {
      const cache = new FileCache();
      const tool = fakeTool({ name: 'Read', execute: () => ({ success: true, output: 'ok' }) });
      const permissions = new PermissionManager();
      permissions.allowAll('Read');
      const ctx = makeCtx({
        permissions,
        toolRegistry: makeRegistry([tool]),
        fileCache: cache,
      });
      await collect(runToolCalls([callOf('Read', { file_path: fp })], ctx, 'sig', makeRecovery()));
      assert.ok(cache.get(fp), 'fileCache should have recorded the file');
    } finally {
      await fs.unlink(fp).catch(() => undefined);
    }
  });

  it('invalidates the cache after a successful Edit', async () => {
    const fp = tmp();
    await fs.writeFile(fp, 'old');
    try {
      const cache = new FileCache();
      cache.record(fp, { mtimeMs: 1, size: 3, hash: 'h' });
      const tool = fakeTool({ name: 'Edit', category: 'write' });
      const permissions = new PermissionManager();
      permissions.allowAll('Edit');
      const ctx = makeCtx({
        permissions,
        toolRegistry: makeRegistry([tool]),
        fileCache: cache,
      });
      await collect(runToolCalls([callOf('Edit', { file_path: fp })], ctx, 'sig', makeRecovery()));
      assert.strictEqual(cache.get(fp), undefined);
    } finally {
      await fs.unlink(fp).catch(() => undefined);
    }
  });
});

describe('runToolCalls — corrector', () => {
  it('runs the corrector once on failure and replaces the prior tool_result', async () => {
    let attempt = 0;
    const tool = fakeTool({
      name: 'Read',
      execute: args => {
        attempt++;
        // First call fails (wrong path), second call succeeds (corrected path).
        if (args.file_path === '/wrong') {
          return { success: false, output: 'ENOENT' };
        }
        return { success: true, output: 'CORRECTED' };
      },
    });
    const permissions = new PermissionManager();
    permissions.allowAll('Read');
    const provider = makeProvider({
      modelTier: 'strong',
      noStreamResponses: ['{"name":"Read","arguments":{"file_path":"/right"}}'],
    });
    const conv = new Conversation('sys');
    const ctx = makeCtx({
      conversation: conv,
      permissions,
      toolRegistry: makeRegistry([tool]),
      provider,
      enableCorrector: true,
      userInput: 'read the file',
    });
    const { events } = await collect(
      runToolCalls([callOf('Read', { file_path: '/wrong' })], ctx, 'sig', makeRecovery()),
    );
    assert.strictEqual(attempt, 2, 'tool ran once for original, once for corrected call');
    assert.ok(events.some(e => e.type === 'tool-call-corrected'));
    const toolMessages = conv.getMessages().filter(m => m.role === 'tool');
    assert.strictEqual(toolMessages.length, 1, 'replaceLastToolResult means one tool message');
    assert.match(toolMessages[0]!.content, /Tool corrector:.*CORRECTED/s);
  });

  it('routes the corrector through a weak-tier model when available', async () => {
    const modelLog: string[] = [];
    const tool = fakeTool({
      name: 'Read',
      execute: () => ({ success: false, output: 'nope' }),
    });
    const permissions = new PermissionManager();
    permissions.allowAll('Read');
    const provider = makeProvider({
      name: 'anthropic',
      modelTier: 'strong',
      noStreamResponses: ['{"name":"Read","arguments":{"file_path":"/x"}}'],
      modelLog,
    });
    const ctx = makeCtx({
      permissions,
      toolRegistry: makeRegistry([tool]),
      provider,
      enableCorrector: true,
      model: 'claude-opus-4',
    });
    await collect(runToolCalls([callOf('Read', { file_path: '/x' })], ctx, 'sig', makeRecovery()));
    assert.deepStrictEqual(modelLog, ['claude-haiku-4-5-20251001']);
  });

  it('does not invoke the corrector twice for the same (name, args) signature', async () => {
    let chatCalls = 0;
    const tool = fakeTool({
      name: 'Read',
      execute: () => ({ success: false, output: 'fail' }),
    });
    const permissions = new PermissionManager();
    permissions.allowAll('Read');
    const provider = makeProvider({
      modelTier: 'strong',
      noStreamResponses: ['{"name":"Read","arguments":{"file_path":"/x"}}'],
    });
    // Override chatNoStream to count calls.
    const originalNoStream = provider.chatNoStream.bind(provider);
    provider.chatNoStream = async (...args) => {
      chatCalls++;
      return originalNoStream(...args);
    };
    const recovery = makeRecovery();
    const ctx = makeCtx({
      permissions,
      toolRegistry: makeRegistry([tool]),
      provider,
      enableCorrector: true,
    });
    const args = { file_path: '/dup' };
    await collect(runToolCalls([callOf('Read', args, 'a')], ctx, 'sig', recovery));
    await collect(runToolCalls([callOf('Read', args, 'b')], ctx, 'sig', recovery));
    assert.strictEqual(chatCalls, 1, 'corrector only fired for the first identical call');
  });

  it('skips the corrector when the failed result is flagged skipCorrector', async () => {
    // Regression: the Edit tool's "found N times — must be unique" failure
    // is a reasoning hint for the main model (it has the file in context),
    // not a malformed-call problem the corrector can fix from an 8000-char
    // truncated slice. The tool sets skipCorrector and the loop must honor
    // it — otherwise the corrector fabricates context lines and burns the
    // single corrector slot the agent gets per (name, args) signature.
    let chatCalls = 0;
    const tool = fakeTool({
      name: 'Edit',
      execute: () => ({
        success: false,
        output: 'old_string found 3 times — must be unique',
        skipCorrector: true,
      }),
    });
    const permissions = new PermissionManager();
    permissions.allowAll('Edit');
    const provider = makeProvider({
      modelTier: 'strong',
      noStreamResponses: ['{"name":"Edit","arguments":{}}'],
    });
    const original = provider.chatNoStream.bind(provider);
    provider.chatNoStream = async (...args) => {
      chatCalls++;
      return original(...args);
    };
    const ctx = makeCtx({
      permissions,
      toolRegistry: makeRegistry([tool]),
      provider,
      enableCorrector: true,
    });
    const { events } = await collect(
      runToolCalls(
        [callOf('Edit', { file_path: '/x', old_string: 'a', new_string: 'b' })],
        ctx,
        'sig',
        makeRecovery(),
      ),
    );
    assert.strictEqual(chatCalls, 0, 'corrector model not consulted');
    assert.ok(!events.some(e => e.type === 'tool-call-corrected'));
    assert.ok(!events.some(e => e.type === 'tool-call-corrector-aborted'));
  });

  it('respects the corrector budget', async () => {
    let chatCalls = 0;
    const tool = fakeTool({
      name: 'Read',
      execute: () => ({ success: false, output: 'fail' }),
    });
    const permissions = new PermissionManager();
    permissions.allowAll('Read');
    const provider = makeProvider({
      modelTier: 'strong',
      noStreamResponses: ['{"action":"abort","reason":"x"}'],
    });
    const original = provider.chatNoStream.bind(provider);
    provider.chatNoStream = async (...args) => {
      chatCalls++;
      return original(...args);
    };
    const recovery = makeRecovery(0); // budget exhausted from the start
    const ctx = makeCtx({
      permissions,
      toolRegistry: makeRegistry([tool]),
      provider,
      enableCorrector: true,
    });
    await collect(runToolCalls([callOf('Read', { file_path: '/x' })], ctx, 'sig', recovery));
    assert.strictEqual(chatCalls, 0, 'corrector skipped when budget is zero');
  });

  it('records a fingerprint into fileCache when the corrected Read succeeds', async () => {
    const wrong = '/does-not-exist-' + Math.random();
    const right = tmp();
    await fs.writeFile(right, 'hello');
    try {
      const cache = new FileCache();
      const tool = fakeTool({
        name: 'Read',
        execute: async args => {
          if (args.file_path === wrong) return { success: false, output: 'ENOENT' };
          return { success: true, output: 'hello' };
        },
      });
      const permissions = new PermissionManager();
      permissions.allowAll('Read');
      const provider = makeProvider({
        modelTier: 'strong',
        noStreamResponses: [JSON.stringify({ name: 'Read', arguments: { file_path: right } })],
      });
      const ctx = makeCtx({
        permissions,
        toolRegistry: makeRegistry([tool]),
        provider,
        enableCorrector: true,
        fileCache: cache,
      });
      await collect(
        runToolCalls([callOf('Read', { file_path: wrong })], ctx, 'sig', makeRecovery()),
      );
      assert.ok(
        cache.get(right),
        'fileCache should have recorded the corrected Read so a follow-up read short-circuits',
      );
    } finally {
      await fs.unlink(right).catch(() => undefined);
    }
  });

  it('skips the corrector entirely in plan mode', async () => {
    let chatCalls = 0;
    const tool = fakeTool({
      name: 'Read',
      category: 'read-only',
      execute: () => ({ success: false, output: 'fail' }),
    });
    const permissions = new PermissionManager();
    permissions.allowAll('Read');
    const provider = makeProvider({
      modelTier: 'strong',
      noStreamResponses: ['{"name":"Read","arguments":{}}'],
    });
    const original = provider.chatNoStream.bind(provider);
    provider.chatNoStream = async (...args) => {
      chatCalls++;
      return original(...args);
    };
    const ctx = makeCtx({
      permissions,
      toolRegistry: makeRegistry([tool]),
      provider,
      enableCorrector: true,
      planMode: true,
    });
    await collect(runToolCalls([callOf('Read', { file_path: '/x' })], ctx, 'sig', makeRecovery()));
    assert.strictEqual(chatCalls, 0);
  });
});

describe('runToolCalls — bash dedup', () => {
  it('fires a nudge after enough near-duplicate Bash commands', async () => {
    const tool = fakeTool({ name: 'Bash' });
    const permissions = new PermissionManager();
    permissions.setBashRules([{ pattern: '*', decision: 'allow' }]);
    const tracker = new BashDedupTracker();
    const ctx = makeCtx({
      permissions,
      toolRegistry: makeRegistry([tool]),
      bashDedup: tracker,
    });
    // Three near-identical commands → 3rd should fire.
    await collect(
      runToolCalls([callOf('Bash', { command: 'grep -n foo a.ts' })], ctx, 's1', makeRecovery()),
    );
    await collect(
      runToolCalls([callOf('Bash', { command: 'grep -n foo b.ts' })], ctx, 's2', makeRecovery()),
    );
    const { events } = await collect(
      runToolCalls([callOf('Bash', { command: 'grep -n foo c.ts' })], ctx, 's3', makeRecovery()),
    );
    assert.ok(events.some(e => e.type === 'bash-dedup-nudge'));
  });
});

describe('runToolCalls — hooks', () => {
  // PreToolUse hook printing {"cancel": true, ...} should veto. Real shell
  // is fine here — hooks always exec via sh.
  it('vetoes on PreToolUse cancel and skips execution', async () => {
    const tool = fakeTool({ name: 'Read' });
    const permissions = new PermissionManager();
    permissions.allowAll('Read');
    const conv = new Conversation('sys');
    const ctx = makeCtx({
      conversation: conv,
      permissions,
      toolRegistry: makeRegistry([tool]),
      hooksEnabled: true,
      hooksConfig: {
        PreToolUse: [
          {
            command: `cat >/dev/null && echo '{"cancel":true,"errorMessage":"blocked by test hook"}'`,
          },
        ],
      },
    });
    const { events, result } = await collect(
      runToolCalls([callOf('Read', { file_path: '/x' })], ctx, 'sig', makeRecovery()),
    );
    assert.strictEqual(tool.calls.length, 0);
    assert.ok(events.some(e => e.type === 'hook-veto'));
    assert.ok(events.some(e => e.type === 'tool-call-denied'));
    assert.strictEqual(result.deniedCount, 1);
    assert.match(conv.getMessages().at(-1)!.content, /blocked by test hook/);
  });

  it('fires PostToolUse on success and PostToolUseFailure on failure', async () => {
    const successTool = fakeTool({ name: 'Read' });
    const permissions = new PermissionManager();
    permissions.allowAll('Read');
    const ctx = makeCtx({
      permissions,
      toolRegistry: makeRegistry([successTool]),
      hooksEnabled: true,
      hooksConfig: {
        PostToolUse: [{ command: `cat >/dev/null && echo '{}'` }],
        PostToolUseFailure: [{ command: `cat >/dev/null && echo '{}'` }],
      },
    });
    const { events: okEvents } = await collect(
      runToolCalls([callOf('Read')], ctx, 'sig', makeRecovery()),
    );
    const okHookFired = okEvents.find(e => e.type === 'hook-fired' && e.event === 'PostToolUse');
    assert.ok(okHookFired, 'PostToolUse fires on success');
    assert.ok(
      !okEvents.some(e => e.type === 'hook-fired' && e.event === 'PostToolUseFailure'),
      'PostToolUseFailure does NOT fire on success',
    );

    const failTool = fakeTool({
      name: 'Read',
      execute: () => ({ success: false, output: 'nope' }),
    });
    const ctx2 = makeCtx({
      permissions,
      toolRegistry: makeRegistry([failTool]),
      hooksEnabled: true,
      hooksConfig: {
        PostToolUse: [{ command: `cat >/dev/null && echo '{}'` }],
        PostToolUseFailure: [{ command: `cat >/dev/null && echo '{}'` }],
      },
    });
    const { events: failEvents } = await collect(
      runToolCalls([callOf('Read')], ctx2, 'sig', makeRecovery()),
    );
    assert.ok(
      failEvents.some(e => e.type === 'hook-fired' && e.event === 'PostToolUseFailure'),
      'PostToolUseFailure fires on failure',
    );
    assert.ok(
      !failEvents.some(e => e.type === 'hook-fired' && e.event === 'PostToolUse'),
      'PostToolUse does NOT fire on failure',
    );
  });
});
