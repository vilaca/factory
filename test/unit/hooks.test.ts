import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runHook } from '../../src/core/hooks/index.js';
import { discoverHookScripts } from '../../src/core/hooks/discovery.js';

let tmpDir: string;

async function writeScript(name: string, body: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, body, { mode: 0o755 });
  return p;
}

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-hooks-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('runHook', () => {
  it('is a no-op when no hook scripts exist', async () => {
    const result = await runHook(
      'SessionStart',
      { foo: 'bar' },
      { cwd: tmpDir, scripts: [] },
    );
    assert.strictEqual(result.cancel, false);
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.errorMessage, undefined);
    assert.strictEqual(result.contextModification, undefined);
  });

  it('parses cancel:true and surfaces errorMessage', async () => {
    const script = await writeScript(
      'cancel.sh',
      `#!/bin/sh\nread -r INPUT\necho '{"cancel": true, "errorMessage": "blocked by policy"}'\n`,
    );
    const result = await runHook(
      'PreToolUse',
      { toolName: 'Bash' },
      { cwd: tmpDir, scripts: [script] },
    );
    assert.strictEqual(result.cancel, true);
    assert.strictEqual(result.errorMessage, 'blocked by policy');
    assert.strictEqual(result.errors.length, 0);
  });

  it('captures contextModification from PreCompact-style hooks', async () => {
    const script = await writeScript(
      'precompact.sh',
      `#!/bin/sh\nread -r INPUT\necho '{"contextModification": "synthetic summary"}'\n`,
    );
    const result = await runHook(
      'PreCompact',
      { aggressive: false },
      { cwd: tmpDir, scripts: [script] },
    );
    assert.strictEqual(result.cancel, false);
    assert.strictEqual(result.contextModification, 'synthetic summary');
  });

  it('records an error when hook stdout is malformed JSON', async () => {
    const script = await writeScript(
      'malformed.sh',
      `#!/bin/sh\ncat >/dev/null\necho 'not-json-at-all'\n`,
    );
    const result = await runHook(
      'PostToolUse',
      {},
      { cwd: tmpDir, scripts: [script] },
    );
    assert.strictEqual(result.cancel, false);
    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0], /malformed JSON/);
  });

  it('kills the hook on timeout and reports it as an error', async () => {
    const script = await writeScript(
      'sleeper.sh',
      `#!/bin/sh\nsleep 10\necho '{}'\n`,
    );
    const start = Date.now();
    const result = await runHook(
      'SessionStart',
      {},
      { cwd: tmpDir, scripts: [script], timeoutMs: 200 },
    );
    const elapsed = Date.now() - start;
    assert.strictEqual(result.cancel, false);
    assert.strictEqual(result.errors.length, 1);
    assert.match(result.errors[0], /timed out/);
    // Should be much closer to 200ms than to 10000ms.
    assert.ok(elapsed < 2000, `expected fast kill, took ${elapsed}ms`);
  });

  it('forwards stderr lines to the onStderr sink', async () => {
    const script = await writeScript(
      'stderr.sh',
      `#!/bin/sh\nread -r INPUT\necho 'diag line' >&2\necho '{}'\n`,
    );
    const seen: { hookPath: string; chunk: string }[] = [];
    await runHook(
      'SessionStart',
      {},
      {
        cwd: tmpDir,
        scripts: [script],
        onStderr: (hookPath, chunk) => seen.push({ hookPath, chunk }),
      },
    );
    assert.ok(seen.length > 0, 'expected at least one stderr emission');
    assert.match(seen.map(s => s.chunk).join(''), /diag line/);
  });

  it('aggregates multiple hooks (project hook overrides errorMessage)', async () => {
    const a = await writeScript(
      'a.sh',
      `#!/bin/sh\ncat >/dev/null\necho '{"cancel": true, "errorMessage": "from-a"}'\n`,
    );
    const b = await writeScript(
      'b.sh',
      `#!/bin/sh\ncat >/dev/null\necho '{"errorMessage": "from-b"}'\n`,
    );
    const result = await runHook(
      'PreToolUse',
      {},
      { cwd: tmpDir, scripts: [a, b] },
    );
    assert.strictEqual(result.cancel, true);
    // Last non-empty errorMessage wins.
    assert.strictEqual(result.errorMessage, 'from-b');
  });

  it('passes the event JSON payload on stdin', async () => {
    const outFile = path.join(tmpDir, 'stdin-capture.txt');
    const script = await writeScript(
      'capture.sh',
      `#!/bin/sh\ncat > "${outFile}"\necho '{}'\n`,
    );
    await runHook(
      'UserPromptSubmit',
      { userInput: 'hello world' },
      { cwd: tmpDir, scripts: [script] },
    );
    const captured = await fs.readFile(outFile, 'utf-8');
    const parsed = JSON.parse(captured);
    assert.strictEqual(parsed.event, 'UserPromptSubmit');
    assert.deepStrictEqual(parsed.payload, { userInput: 'hello world' });
  });
});

describe('discoverHookScripts', () => {
  it('returns an empty list when no hooks exist', () => {
    const scripts = discoverHookScripts('SessionStart', tmpDir);
    // tmpDir has no .factory/hooks subdir, so no project hook. Global hook
    // (in real $HOME) might exist on the developer's machine — that's fine,
    // we only assert the returned list is well-formed.
    for (const s of scripts) {
      assert.ok(typeof s === 'string' && s.endsWith('SessionStart.sh'));
    }
  });

  it('finds a project-local hook under <cwd>/.factory/hooks/', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-hooks-proj-'));
    try {
      const hooksDir = path.join(projectDir, '.factory', 'hooks');
      await fs.mkdir(hooksDir, { recursive: true });
      const hookPath = path.join(hooksDir, 'PreToolUse.sh');
      await fs.writeFile(hookPath, '#!/bin/sh\necho "{}"\n', { mode: 0o755 });
      const scripts = discoverHookScripts('PreToolUse', projectDir);
      assert.ok(scripts.includes(hookPath), `expected ${hookPath} in ${JSON.stringify(scripts)}`);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });
});
