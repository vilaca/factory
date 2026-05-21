/**
 * Path-jail enforcement: Read/Write/Edit must refuse to touch the built-in
 * secret-path list even when the tool is in permissions.allowAll. This is
 * the headless-wired counterpart to the unit-level checks in
 * test/unit/security/security-paths.test.ts.
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

let env: ReturnType<typeof tmpEnv>;
beforeEach(() => {
  if (env) env.cleanup();
  env = tmpEnv();
  writeProjectConfig(env.cwd, { permissions: { allowAll: ['Read', 'Write', 'Bash'] } });
});
after(() => env?.cleanup());

function args(): string[] {
  return [
    '--provider',
    'ollama',
    '--model',
    'test-model:latest',
    '--host',
    `http://127.0.0.1:${mockPort}`,
  ];
}

describe('Path jail', () => {
  // ~/.ssh resolves against the spawned process's HOME (we override). Place
  // a real-looking secret in the jailed path and assert Read refuses it
  // even with allowAll Read.
  it('refuses Read of ~/.ssh/id_rsa', async () => {
    const sshDir = path.join(env.home, '.ssh');
    fs.mkdirSync(sshDir, { recursive: true });
    fs.writeFileSync(path.join(sshDir, 'id_rsa'), 'SECRET_KEY_CONTENT');
    setNextResponses([
      {
        content: '',
        tool_calls: [
          {
            function: {
              name: 'Read',
              arguments: { file_path: path.join(sshDir, 'id_rsa') },
            },
          },
        ],
      },
      { content: 'done' },
    ]);
    const r = await spawnCliHeadless(args(), {
      stdin: 'read it\n',
      home: env.home,
      cwd: env.cwd,
    });
    // Tool result should be a refusal — assert the secret never appears in
    // stdout or stderr (otherwise the path-jail let it through).
    assert.ok(!r.stdout.includes('SECRET_KEY_CONTENT'), 'secret leaked to stdout');
    assert.ok(!r.stderr.includes('SECRET_KEY_CONTENT'), 'secret leaked to stderr');
  });

  it('refuses Read of /etc/shadow', async () => {
    setNextResponses([
      {
        content: '',
        tool_calls: [
          {
            function: { name: 'Read', arguments: { file_path: '/etc/shadow' } },
          },
        ],
      },
      { content: 'done' },
    ]);
    const r = await spawnCliHeadless(args(), {
      stdin: 'read shadow\n',
      home: env.home,
      cwd: env.cwd,
    });
    // Whether the file exists is OS-dependent; the assertion is that the
    // refusal *is* what stops it — the tool call should fail.
    assert.match(r.stderr, /✗ Read|denied|refused/i);
  });
});
