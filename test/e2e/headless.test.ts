/**
 * Headless-mode end-to-end. Each test drives a real factory binary with
 * stdin piped, then asserts on exit code + stream contents. The mock
 * Ollama server stands in for a real provider so no network is touched.
 *
 * Exit-code contract (see src/ui/headless.ts):
 *   0  — turn completed cleanly
 *   1  — agent error
 *   2  — empty stdin
 *   3  — gated tool with no TTY to prompt
 *   5  — turn-complete with stopReason 'token-limit'
 *   6  — strict-log enabled and logger init / first write failed
 *   130 — SIGINT
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnCliHeadless } from '../cli-harness.js';
import {
  startMockServer,
  stopMockServer,
  setNextResponses,
  setNextResponse,
} from '../mock-ollama-server.js';

let mockPort: number;
let mockServer: any;

before(async () => {
  const r = await startMockServer();
  mockServer = r.server;
  mockPort = r.port;
});

after(async () => {
  await stopMockServer(mockServer);
});

function baseArgs(extra: string[] = []): string[] {
  return [
    '--provider',
    'ollama',
    '--model',
    'test-model:latest',
    '--host',
    `http://127.0.0.1:${mockPort}`,
    ...extra,
  ];
}

describe('Headless mode', () => {
  it('streams the assistant reply to stdout and exits 0', async () => {
    setNextResponse({ content: 'Hello from the mock' });
    const r = await spawnCliHeadless(baseArgs(), { stdin: 'say hi\n' });
    assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.includes('Hello from the mock'),
      `expected mock reply in stdout, got: ${r.stdout}`,
    );
  });

  it('exits 2 when stdin is empty', async () => {
    const r = await spawnCliHeadless(baseArgs(), { stdin: '' });
    assert.strictEqual(r.exitCode, 2);
    assert.match(r.stderr, /no input on stdin/);
  });

  it('exits 3 when the model calls a gated tool with no TTY', async () => {
    // Model tries to call Bash. Headless cannot prompt → permission-request
    // is auto-denied and exitCode becomes 3 in the finally block. The mock
    // queues a single tool-call response; the agent surfaces a denied event,
    // halts on all-denied, and falls through to the exit-code rewrite path.
    setNextResponses([
      {
        content: '',
        tool_calls: [
          {
            function: { name: 'Bash', arguments: { command: 'echo hi' } },
          },
        ],
      },
    ]);
    const r = await spawnCliHeadless(baseArgs(), { stdin: 'run echo hi\n' });
    assert.strictEqual(
      r.exitCode,
      3,
      `expected exit 3 (no-TTY permission), got ${r.exitCode}; stderr: ${r.stderr}`,
    );
    assert.match(r.stderr, /requires permission|permissions\.allowAll/);
  });

  it('writes a session log JSONL under ~/.factory/sessions by default', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-headless-log-'));
    setNextResponse({ content: 'logged' });
    const r = await spawnCliHeadless(baseArgs(), { stdin: 'log me\n', home });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    const sessionsDir = path.join(home, '.factory', 'sessions');
    assert.ok(fs.existsSync(sessionsDir), `sessions dir not created: ${sessionsDir}`);
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
    assert.ok(files.length >= 1, `no JSONL written under ${sessionsDir}`);
    const lines = fs.readFileSync(path.join(sessionsDir, files[0]!), 'utf8').trim().split('\n');
    // First line is a session-start record; user input is logged separately.
    const parsed = lines.map(l => JSON.parse(l));
    assert.ok(
      parsed.some(p => p.type === 'session-start' || p.event === 'session-start'),
      `expected a session-start entry; got types ${parsed.map(p => p.type ?? p.event).join(',')}`,
    );
  });

  it('--no-log suppresses the session log entirely', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-headless-nolog-'));
    setNextResponse({ content: 'silent' });
    const r = await spawnCliHeadless(baseArgs(['--no-log']), { stdin: 'hi\n', home });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    const sessionsDir = path.join(home, '.factory', 'sessions');
    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      assert.strictEqual(files.length, 0, `--no-log left ${files.length} JSONL file(s)`);
    }
  });

  it('--strict-log exits 6 when the sessions dir cannot be created', async () => {
    // Pre-create ~/.factory/sessions as a *file*, so mkdirSync('sessions',
    // {recursive: true}) inside session-log.ts fails with ENOTDIR.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-headless-strict-'));
    fs.mkdirSync(path.join(home, '.factory'), { recursive: true });
    fs.writeFileSync(path.join(home, '.factory', 'sessions'), 'not a directory');
    setNextResponse({ content: 'ignored' });
    const r = await spawnCliHeadless(baseArgs(['--strict-log']), {
      stdin: 'whatever\n',
      home,
    });
    assert.strictEqual(
      r.exitCode,
      6,
      `expected exit 6 from --strict-log, got ${r.exitCode}; stderr: ${r.stderr}`,
    );
  });

  it('stderr is separated from stdout — model reply on stdout only', async () => {
    setNextResponse({ content: 'PURE_STDOUT_PAYLOAD' });
    const r = await spawnCliHeadless(baseArgs(), { stdin: 'go\n' });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('PURE_STDOUT_PAYLOAD'));
    assert.ok(
      !r.stderr.includes('PURE_STDOUT_PAYLOAD'),
      `model text leaked onto stderr: ${r.stderr}`,
    );
  });

  it('surfaces a hook warning to stderr and logs it to the session JSONL', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-headless-hookwarn-'));
    const cfgDir = path.join(home, '.config', 'factory');
    fs.mkdirSync(cfgDir, { recursive: true });
    const hookCommand = "echo 'warn-from-hook' >&2; echo '{}'";
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify(
        {
          agent: {
            experimental: { hooks: true },
            hooks: { SessionStart: [{ command: hookCommand }] },
          },
        },
        null,
        2,
      ),
    );

    setNextResponse({ content: 'ok' });
    const r = await spawnCliHeadless(baseArgs(), { stdin: 'hi\n', home });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.match(r.stderr, /warn-from-hook/);

    const sessionsDir = path.join(home, '.factory', 'sessions');
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
    assert.ok(files.length >= 1, `no session log file under ${sessionsDir}`);

    const raw = fs.readFileSync(path.join(sessionsDir, files[0]!), 'utf8');
    const rows = raw
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { type?: string; source?: string; message?: string });

    const hookWarning = rows.find(
      row =>
        row.type === 'warning' &&
        row.source === 'hook-stderr' &&
        typeof row.message === 'string' &&
        row.message.includes('warn-from-hook'),
    );
    assert.ok(hookWarning, 'expected hook-stderr warning row in session log');
  });

  it('surfaces an agent error to stderr and logs it as source=agent-error', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-headless-agenterr-'));
    setNextResponses([
      {
        content: '',
        tool_calls: [
          {
            function: { name: 'DefinitelyNotATool', arguments: {} },
          },
        ],
      },
    ]);

    const r = await spawnCliHeadless(baseArgs(), { stdin: 'hi\n', home });

    assert.strictEqual(r.exitCode, 1, `expected exit 1, got ${r.exitCode}; stderr: ${r.stderr}`);
    assert.match(r.stderr, /factory: Error: unknown tool "DefinitelyNotATool"/);

    const sessionsDir = path.join(home, '.factory', 'sessions');
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
    assert.ok(files.length >= 1, `no session log file under ${sessionsDir}`);

    const raw = fs.readFileSync(path.join(sessionsDir, files[0]!), 'utf8');
    const rows = raw
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { type?: string; source?: string; message?: string });

    const agentError = rows.find(
      row =>
        row.type === 'warning' &&
        row.source === 'agent-error' &&
        typeof row.message === 'string' &&
        row.message.includes('unknown tool "DefinitelyNotATool"'),
    );
    assert.ok(agentError, 'expected agent-error warning row in session log');
  });

  it('prints a scoped-instructions notice after touching a directory with AGENTS/CLAUDE files', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-headless-scoped-instr-'));
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'root guidance');
    fs.writeFileSync(path.join(cwd, 'src', 'CLAUDE.md'), 'nested guidance');
    fs.writeFileSync(path.join(cwd, 'src', 'hello.txt'), 'hello');

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-headless-scoped-home-'));
    fs.mkdirSync(path.join(home, '.config', 'factory'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.config', 'factory', 'config.json'),
      JSON.stringify({ permissions: { allowAll: ['Read'] } }),
    );

    try {
      setNextResponses([
        {
          content: '',
          tool_calls: [
            {
              function: { name: 'Read', arguments: { file_path: 'src/hello.txt' } },
            },
          ],
        },
        { content: 'done' },
      ]);

      const r = await spawnCliHeadless(baseArgs(), {
        stdin: 'inspect src/hello.txt\n',
        cwd,
        home,
      });
      assert.strictEqual(r.exitCode, 0, r.stderr);
      assert.match(r.stderr, /loaded scoped project instructions/i);
      assert.match(r.stderr, /AGENTS\.md/);
      assert.match(r.stderr, /CLAUDE\.md/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
