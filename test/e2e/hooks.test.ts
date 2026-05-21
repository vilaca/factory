/**
 * Lifecycle hooks fire from the same code path in headless and TUI mode.
 * Strategy: configure a hook whose command is `touch <marker>` and assert
 * the marker file exists after the run. Marker presence proves the hook
 * was invoked at the right phase; absence proves the wiring is broken.
 *
 * Project-level hooks require the trust prompt — headless can't answer one,
 * so use global-config hooks here. The unit suite covers the trust gate.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { spawnCliHeadless } from '../cli-harness.js';
import { startMockServer, stopMockServer, setNextResponse } from '../mock-ollama-server.js';
import { tmpEnv } from '../fixtures/tmpProject.js';
import { writeGlobalConfig } from '../fixtures/writeConfig.js';
import { markerHookCommand } from '../fixtures/writeHook.js';

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

describe('Hooks (headless)', () => {
  it('SessionStart hook fires once at startup', async () => {
    const marker = path.join(env.home, 'session-start.marker');
    writeGlobalConfig(env.home, {
      provider: 'ollama',
      model: 'test-model:latest',
      host: `http://127.0.0.1:${mockPort}`,
      agent: {
        experimental: { hooks: true },
        hooks: { SessionStart: [{ command: markerHookCommand(marker) }] },
      },
    });
    setNextResponse({ content: 'hello' });
    const r = await spawnCliHeadless(args(), {
      stdin: 'hi\n',
      home: env.home,
      cwd: env.cwd,
    });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.ok(fs.existsSync(marker), `SessionStart marker not created: ${marker}`);
  });

  it('SessionEnd hook fires on normal exit', async () => {
    const marker = path.join(env.home, 'session-end.marker');
    writeGlobalConfig(env.home, {
      provider: 'ollama',
      model: 'test-model:latest',
      host: `http://127.0.0.1:${mockPort}`,
      agent: {
        experimental: { hooks: true },
        hooks: { SessionEnd: [{ command: markerHookCommand(marker) }] },
      },
    });
    setNextResponse({ content: 'bye' });
    const r = await spawnCliHeadless(args(), {
      stdin: 'hi\n',
      home: env.home,
      cwd: env.cwd,
    });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.ok(fs.existsSync(marker), `SessionEnd marker not created: ${marker}`);
  });

  it('--no-hooks suppresses hook execution', async () => {
    const marker = path.join(env.home, 'should-not-exist.marker');
    writeGlobalConfig(env.home, {
      provider: 'ollama',
      model: 'test-model:latest',
      host: `http://127.0.0.1:${mockPort}`,
      agent: {
        experimental: { hooks: true },
        hooks: { SessionStart: [{ command: markerHookCommand(marker) }] },
      },
    });
    setNextResponse({ content: 'hi' });
    const r = await spawnCliHeadless([...args(), '--no-hooks'], {
      stdin: 'hi\n',
      home: env.home,
      cwd: env.cwd,
    });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.ok(!fs.existsSync(marker), `--no-hooks still fired the hook: ${marker}`);
  });
});
