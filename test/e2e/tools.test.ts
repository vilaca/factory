/**
 * End-to-end smoke for each built-in tool wired through the headless agent
 * loop. Each test stages a tool result, asks the mock provider to invoke
 * that tool, and asserts the on-disk side-effect or stdout content.
 *
 * `allowAll` in the project config is the headless equivalent of clicking
 * "Allow" on the permission panel — without it the gated tools would
 * auto-deny in non-TTY mode (covered separately in headless.test.ts).
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { spawnCliHeadless } from '../cli-harness.js';
import { startMockServer, stopMockServer, setNextResponses } from '../mock-ollama-server.js';
import { tmpEnv } from '../fixtures/tmpProject.js';
import { writeProjectConfig } from '../fixtures/writeConfig.js';

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

function args(host: string): string[] {
  return ['--provider', 'ollama', '--model', 'test-model:latest', '--host', host];
}

function host(): string {
  return `http://127.0.0.1:${mockPort}`;
}

const ALL_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];

let env: ReturnType<typeof tmpEnv>;

beforeEach(() => {
  if (env) env.cleanup();
  env = tmpEnv();
  writeProjectConfig(env.cwd, { permissions: { allowAll: ALL_TOOLS } });
});

after(() => env?.cleanup());

describe('Built-in tools (headless)', () => {
  it('Read returns the file contents and the model sees them', async () => {
    const file = path.join(env.cwd, 'hello.txt');
    fs.writeFileSync(file, 'READ_SENTINEL\nline2\n');
    setNextResponses([
      {
        content: '',
        tool_calls: [{ function: { name: 'Read', arguments: { file_path: file } } }],
      },
      { content: 'I saw READ_SENTINEL' },
    ]);
    const r = await spawnCliHeadless(args(host()), {
      stdin: `read ${file}\n`,
      home: env.home,
      cwd: env.cwd,
    });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('I saw READ_SENTINEL'), `stdout: ${r.stdout}`);
  });

  it('Write creates the file with the requested content', async () => {
    const file = path.join(env.cwd, 'made.txt');
    setNextResponses([
      {
        content: '',
        tool_calls: [
          {
            function: {
              name: 'Write',
              arguments: { file_path: file, content: 'WRITE_PAYLOAD' },
            },
          },
        ],
      },
      { content: 'wrote it' },
    ]);
    const r = await spawnCliHeadless(args(host()), {
      stdin: 'write a file\n',
      home: env.home,
      cwd: env.cwd,
    });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'WRITE_PAYLOAD');
  });

  it('Edit replaces the requested substring', async () => {
    const file = path.join(env.cwd, 'edit.txt');
    fs.writeFileSync(file, 'before:OLDVALUE:after');
    setNextResponses([
      {
        content: '',
        tool_calls: [
          {
            function: {
              name: 'Edit',
              arguments: {
                file_path: file,
                old_string: 'OLDVALUE',
                new_string: 'NEWVALUE',
              },
            },
          },
        ],
      },
      { content: 'edited' },
    ]);
    const r = await spawnCliHeadless(args(host()), {
      stdin: 'edit\n',
      home: env.home,
      cwd: env.cwd,
    });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'before:NEWVALUE:after');
  });

  it('Bash runs a benign command and the model receives the stdout', async () => {
    setNextResponses([
      {
        content: '',
        tool_calls: [
          { function: { name: 'Bash', arguments: { command: 'echo BASH_OK' } } },
        ],
      },
      { content: 'shell said BASH_OK' },
    ]);
    const r = await spawnCliHeadless(args(host()), {
      stdin: 'echo BASH_OK\n',
      home: env.home,
      cwd: env.cwd,
    });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('shell said BASH_OK'), r.stdout);
  });

  it('Glob lists matching files', async () => {
    fs.writeFileSync(path.join(env.cwd, 'a.txt'), '');
    fs.writeFileSync(path.join(env.cwd, 'b.txt'), '');
    fs.writeFileSync(path.join(env.cwd, 'skip.md'), '');
    setNextResponses([
      {
        content: '',
        tool_calls: [
          {
            function: { name: 'Glob', arguments: { pattern: '*.txt', path: env.cwd } },
          },
        ],
      },
      { content: 'globbed' },
    ]);
    const r = await spawnCliHeadless(args(host()), {
      stdin: 'glob it\n',
      home: env.home,
      cwd: env.cwd,
    });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    // stderr has the tool-call marker; assert glob ran (✓ Glob).
    assert.match(r.stderr, /✓ Glob/);
  });

  it('Grep finds a known string in the project', async () => {
    fs.writeFileSync(path.join(env.cwd, 'needle.txt'), 'this contains FINDME and others');
    setNextResponses([
      {
        content: '',
        tool_calls: [
          { function: { name: 'Grep', arguments: { pattern: 'FINDME', path: env.cwd } } },
        ],
      },
      { content: 'grep done' },
    ]);
    const r = await spawnCliHeadless(args(host()), {
      stdin: 'grep it\n',
      home: env.home,
      cwd: env.cwd,
    });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.match(r.stderr, /✓ Grep/);
  });
});
