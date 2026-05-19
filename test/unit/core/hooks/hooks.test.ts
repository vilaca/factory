import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runHook } from '../../../../src/core/hooks/index.js';
import { resolveHooks, listAllHooks } from '../../../../src/core/hooks/discovery.js';
import type { HookEntry, HooksConfig } from '../../../../src/core/config/types.js';
import {
  fingerprintHooks,
  fingerprintProjectTrustables,
} from '../../../../src/core/hooks/trust.js';
import type { McpServerConfig } from '../../../../src/mcp/types.js';

let tmpDir: string;

async function writeScript(name: string, body: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, body, { mode: 0o755 });
  return p;
}

function entry(command: string, extra?: Partial<HookEntry>): HookEntry {
  return { command, ...extra };
}

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-hooks-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('runHook', () => {
  it('is a no-op when no entries are configured', async () => {
    const result = await runHook('SessionStart', { foo: 'bar' }, { cwd: tmpDir, entries: [] });
    assert.strictEqual(result.cancel, false);
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.errorMessage, undefined);
    assert.strictEqual(result.additionalContext, undefined);
    assert.deepStrictEqual(result.firedCommands, []);
  });

  it('parses cancel:true and surfaces errorMessage', async () => {
    const script = await writeScript(
      'cancel.sh',
      `#!/bin/sh\nread -r INPUT\necho '{"cancel": true, "errorMessage": "blocked by policy"}'\n`,
    );
    const result = await runHook(
      'PreToolUse',
      { toolName: 'Bash' },
      { cwd: tmpDir, entries: [entry(script)] },
    );
    assert.strictEqual(result.cancel, true);
    assert.strictEqual(result.errorMessage, 'blocked by policy');
    assert.strictEqual(result.errors.length, 0);
  });

  it('captures additionalContext from PreCompact-style hooks', async () => {
    const script = await writeScript(
      'precompact.sh',
      `#!/bin/sh\nread -r INPUT\necho '{"additionalContext": "synthetic summary"}'\n`,
    );
    const result = await runHook(
      'PreCompact',
      { aggressive: false },
      { cwd: tmpDir, entries: [entry(script)] },
    );
    assert.strictEqual(result.cancel, false);
    assert.strictEqual(result.additionalContext, 'synthetic summary');
  });

  it('records an error when hook stdout looks like JSON but fails to parse', async () => {
    const script = await writeScript(
      'malformed.sh',
      `#!/bin/sh\ncat >/dev/null\necho '{not-valid-json'\n`,
    );
    const result = await runHook('PostToolUse', {}, { cwd: tmpDir, entries: [entry(script)] });
    assert.strictEqual(result.cancel, false);
    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0], /malformed JSON/);
  });

  it('treats non-JSON stdout as a plain-text notice', async () => {
    const script = await writeScript(
      'plain.sh',
      `#!/bin/sh\ncat >/dev/null\necho 'Welcome back'\n`,
    );
    const result = await runHook('SessionStart', {}, { cwd: tmpDir, entries: [entry(script)] });
    assert.strictEqual(result.cancel, false);
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.notice, 'Welcome back');
    assert.deepStrictEqual(result.firedCommands, [script]);
  });

  it('caps an oversized plain-text notice', async () => {
    const longLine = 'x'.repeat(500);
    const script = await writeScript('long.sh', `#!/bin/sh\ncat >/dev/null\necho '${longLine}'\n`);
    const result = await runHook('SessionStart', {}, { cwd: tmpDir, entries: [entry(script)] });
    assert.strictEqual(result.errors.length, 0);
    assert.ok(result.notice && result.notice.length <= 201, `got ${result.notice?.length}`);
    assert.ok(result.notice?.endsWith('…'));
  });

  it('runs an inline command without a script file', async () => {
    const result = await runHook(
      'SessionStart',
      {},
      { cwd: tmpDir, entries: [entry(`cat >/dev/null && echo 'hello from inline'`)] },
    );
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.notice, 'hello from inline');
  });

  it('kills the hook on entry-level timeout and reports it as an error', async () => {
    const script = await writeScript('sleeper.sh', `#!/bin/sh\nsleep 10\necho '{}'\n`);
    const start = Date.now();
    const result = await runHook(
      'SessionStart',
      {},
      { cwd: tmpDir, entries: [entry(script, { timeoutMs: 200 })] },
    );
    const elapsed = Date.now() - start;
    assert.strictEqual(result.cancel, false);
    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0], /timed out/);
    assert.ok(elapsed < 2000, `expected fast kill, took ${elapsed}ms`);
  });

  it('forwards stderr lines to the onStderr sink', async () => {
    const script = await writeScript(
      'stderr.sh',
      `#!/bin/sh\nread -r INPUT\necho 'diag line' >&2\necho '{}'\n`,
    );
    const seen: { command: string; chunk: string }[] = [];
    await runHook(
      'SessionStart',
      {},
      {
        cwd: tmpDir,
        entries: [entry(script)],
        onStderr: (command, chunk) => seen.push({ command, chunk }),
      },
    );
    assert.ok(seen.length > 0, 'expected at least one stderr emission');
    assert.match(seen.map(s => s.chunk).join(''), /diag line/);
  });

  it('aggregates multiple hooks (later entry overrides errorMessage)', async () => {
    const a = await writeScript(
      'a.sh',
      `#!/bin/sh\ncat >/dev/null\necho '{"cancel": true, "errorMessage": "from-a"}'\n`,
    );
    const b = await writeScript(
      'b.sh',
      `#!/bin/sh\ncat >/dev/null\necho '{"errorMessage": "from-b"}'\n`,
    );
    const result = await runHook('PreToolUse', {}, { cwd: tmpDir, entries: [entry(a), entry(b)] });
    assert.strictEqual(result.cancel, true);
    assert.strictEqual(result.errorMessage, 'from-b');
  });

  it('blocks hook commands matching built-in forbidden patterns without spawning', async () => {
    const sentinel = path.join(tmpDir, 'should-not-exist.txt');
    // `rm -rf /` matches the rm-rf-root forbidden pattern. We append a
    // touch so that IF the spawn ever ran, the file would appear — proving
    // the check fires before any subshell side-effect.
    const hostileCommand = `rm -rf / 2>/dev/null; touch ${sentinel}`;
    const result = await runHook(
      'SessionStart',
      {},
      { cwd: tmpDir, entries: [entry(hostileCommand)] },
    );
    assert.strictEqual(result.cancel, false);
    assert.strictEqual(result.firedCommands.length, 0);
    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0], /blocked by built-in safety policy/);
    await assert.rejects(fs.stat(sentinel), /ENOENT/);
  });

  it('scrubs the env passed to the hook subprocess', async () => {
    // Pick a name on the deny list (FACTORY_*) and a name not on the
    // allow list (random invented). Both should be absent in the child.
    const fakeSecret = 'FACTORY_TEST_SECRET_DO_NOT_LEAK';
    const fakeOther = 'INVENTED_VAR_NOT_ON_ALLOW_LIST_XYZZY';
    const original = { ...process.env };
    process.env[fakeSecret] = 'leaked-token-value';
    process.env[fakeOther] = 'some-value';
    try {
      const outFile = path.join(tmpDir, 'env-capture.txt');
      const script = await writeScript(
        'env-dump.sh',
        `#!/bin/sh\ncat >/dev/null\nprintenv > "${outFile}"\necho '{}'\n`,
      );
      await runHook('SessionStart', {}, { cwd: tmpDir, entries: [entry(script)] });
      const captured = await fs.readFile(outFile, 'utf-8');
      assert.ok(
        !captured.includes('leaked-token-value'),
        `FACTORY_-prefixed var leaked into hook env:\n${captured}`,
      );
      assert.ok(
        !captured.includes(fakeOther),
        `non-allowlisted var leaked into hook env:\n${captured}`,
      );
      // Sanity: PATH IS allowlisted, should still be visible.
      assert.match(captured, /^PATH=/m);
    } finally {
      process.env = original;
    }
  });

  it('injects FACTORY_PROJECT_DIR / FACTORY_EVENT / FACTORY_TOOL_NAME on the hook env', async () => {
    const outFile = path.join(tmpDir, 'hook-env.txt');
    const script = await writeScript(
      'env-introspect.sh',
      `#!/bin/sh\ncat >/dev/null\nprintenv FACTORY_PROJECT_DIR > "${outFile}"\nprintenv FACTORY_EVENT >> "${outFile}"\nprintenv FACTORY_TOOL_NAME >> "${outFile}"\necho '{}'\n`,
    );
    await runHook(
      'PreToolUse',
      { toolName: 'Bash' },
      { cwd: tmpDir, entries: [entry(script)], matchValue: 'Bash' },
    );
    const captured = (await fs.readFile(outFile, 'utf-8')).split('\n');
    assert.strictEqual(captured[0], tmpDir);
    assert.strictEqual(captured[1], 'PreToolUse');
    assert.strictEqual(captured[2], 'Bash');
  });

  it('omits FACTORY_TOOL_NAME on events without a match value', async () => {
    const outFile = path.join(tmpDir, 'hook-env-no-tool.txt');
    const script = await writeScript(
      'env-no-tool.sh',
      `#!/bin/sh\ncat >/dev/null\nprintenv FACTORY_TOOL_NAME > "${outFile}" || echo '<unset>' > "${outFile}"\necho '{}'\n`,
    );
    await runHook('SessionStart', {}, { cwd: tmpDir, entries: [entry(script)] });
    const captured = (await fs.readFile(outFile, 'utf-8')).trim();
    assert.strictEqual(captured, '<unset>');
  });

  it('passes the event JSON payload on stdin', async () => {
    const outFile = path.join(tmpDir, 'stdin-capture.txt');
    const script = await writeScript('capture.sh', `#!/bin/sh\ncat > "${outFile}"\necho '{}'\n`);
    await runHook(
      'UserPromptSubmit',
      { userInput: 'hello world' },
      { cwd: tmpDir, entries: [entry(script)] },
    );
    const captured = await fs.readFile(outFile, 'utf-8');
    const parsed = JSON.parse(captured);
    assert.strictEqual(parsed.event, 'UserPromptSubmit');
    assert.deepStrictEqual(parsed.payload, { userInput: 'hello world' });
  });
});

describe('resolveHooks', () => {
  it('returns an empty array when config is undefined or empty', () => {
    assert.deepStrictEqual(resolveHooks('SessionStart', undefined), []);
    assert.deepStrictEqual(resolveHooks('SessionStart', {}), []);
    assert.deepStrictEqual(resolveHooks('SessionStart', { SessionStart: [] }), []);
  });

  it('includes entries without a matcher unconditionally', () => {
    const config: HooksConfig = {
      PreToolUse: [{ command: 'a' }, { command: 'b' }],
    };
    assert.deepStrictEqual(resolveHooks('PreToolUse', config), config.PreToolUse);
    assert.deepStrictEqual(resolveHooks('PreToolUse', config, 'Bash'), config.PreToolUse);
  });

  it('filters entries by matcher when a matchValue is provided', () => {
    const config: HooksConfig = {
      PreToolUse: [
        { matcher: 'Bash', command: 'bash-only' },
        { matcher: 'Read|Write', command: 'never-matches-because-glob-not-regex' },
        { matcher: 'B*', command: 'B-prefix' },
        { command: 'always' },
      ],
    };
    const matched = resolveHooks('PreToolUse', config, 'Bash');
    assert.deepStrictEqual(
      matched.map(e => e.command),
      ['bash-only', 'B-prefix', 'always'],
    );
  });

  it('skips matcher-bearing entries when matchValue is undefined', () => {
    const config: HooksConfig = {
      SessionStart: [{ matcher: 'anything', command: 'has-matcher' }, { command: 'no-matcher' }],
    };
    const result = resolveHooks('SessionStart', config);
    assert.deepStrictEqual(
      result.map(e => e.command),
      ['no-matcher'],
    );
  });
});

describe('listAllHooks', () => {
  it('flattens every event into {event, entry} tuples', () => {
    const config: HooksConfig = {
      SessionStart: [{ command: 'start' }],
      PreToolUse: [{ matcher: 'Bash', command: 'pre-bash' }, { command: 'pre-all' }],
    };
    const all = listAllHooks(config);
    assert.deepStrictEqual(
      all.map(({ event, entry }) => ({ event, command: entry.command })),
      [
        { event: 'SessionStart', command: 'start' },
        { event: 'PreToolUse', command: 'pre-bash' },
        { event: 'PreToolUse', command: 'pre-all' },
      ],
    );
  });

  it('returns [] for undefined / empty config', () => {
    assert.deepStrictEqual(listAllHooks(undefined), []);
    assert.deepStrictEqual(listAllHooks({}), []);
  });
});

describe('fingerprintHooks', () => {
  it('produces a stable fingerprint for the same hook config', () => {
    const a: HooksConfig = { SessionStart: [{ command: 'echo hi' }] };
    const b: HooksConfig = { SessionStart: [{ command: 'echo hi' }] };
    assert.strictEqual(fingerprintHooks(a), fingerprintHooks(b));
  });

  it('changes when a command changes', () => {
    const a: HooksConfig = { SessionStart: [{ command: 'echo hi' }] };
    const b: HooksConfig = { SessionStart: [{ command: 'echo bye' }] };
    assert.notStrictEqual(fingerprintHooks(a), fingerprintHooks(b));
  });

  it('changes when a matcher changes', () => {
    const a: HooksConfig = { PreToolUse: [{ matcher: 'Bash', command: 'x' }] };
    const b: HooksConfig = { PreToolUse: [{ matcher: 'Read', command: 'x' }] };
    assert.notStrictEqual(fingerprintHooks(a), fingerprintHooks(b));
  });
});

describe('fingerprintProjectTrustables', () => {
  const hooks: HooksConfig = { SessionStart: [{ command: 'echo hi' }] };
  const mcp: McpServerConfig[] = [{ name: 's', transport: 'stdio', command: '/bin/x' }];

  it('matches fingerprintHooks when no MCP servers are present (back-compat)', () => {
    assert.strictEqual(
      fingerprintProjectTrustables({ hooks, mcpServers: undefined }),
      fingerprintHooks(hooks),
    );
    assert.strictEqual(
      fingerprintProjectTrustables({ hooks, mcpServers: [] }),
      fingerprintHooks(hooks),
    );
  });

  it('changes when an MCP server is added', () => {
    const without = fingerprintProjectTrustables({ hooks, mcpServers: [] });
    const withMcp = fingerprintProjectTrustables({ hooks, mcpServers: mcp });
    assert.notStrictEqual(without, withMcp);
  });

  it('changes when an MCP command changes', () => {
    const a = fingerprintProjectTrustables({ hooks, mcpServers: mcp });
    const b = fingerprintProjectTrustables({
      hooks,
      mcpServers: [{ name: 's', transport: 'stdio', command: '/bin/y' }],
    });
    assert.notStrictEqual(a, b);
  });

  it('changes when an MCP arg changes', () => {
    const a = fingerprintProjectTrustables({
      hooks,
      mcpServers: [{ name: 's', transport: 'stdio', command: '/bin/x', args: ['--a'] }],
    });
    const b = fingerprintProjectTrustables({
      hooks,
      mcpServers: [{ name: 's', transport: 'stdio', command: '/bin/x', args: ['--b'] }],
    });
    assert.notStrictEqual(a, b);
  });

  it('treats undefined hooks the same as empty hooks', () => {
    assert.strictEqual(
      fingerprintProjectTrustables({ hooks: undefined, mcpServers: mcp }),
      fingerprintProjectTrustables({ hooks: {}, mcpServers: mcp }),
    );
  });
});
