/**
 * CLI > project config > global config > defaults. Run the CLI with the
 * same setting expressed three different ways and assert which one wins.
 *
 * Uses --version as a cheap end state when the goal is just to verify the
 * config layer loads without crashing; for value-precedence we use the
 * welcome banner, which echoes the active provider/model and a handful of
 * experimental flags.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { spawnCliHeadless } from '../cli-harness.js';
import { startMockServer, stopMockServer, setNextResponse } from '../mock-ollama-server.js';
import { tmpEnv } from '../fixtures/tmpProject.js';
import { writeGlobalConfig, writeProjectConfig } from '../fixtures/writeConfig.js';

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

function host(): string {
  return `http://127.0.0.1:${mockPort}`;
}

describe('Config precedence', () => {
  it('global config provides defaults when no CLI flag is given', async () => {
    writeGlobalConfig(env.home, {
      provider: 'ollama',
      model: 'test-model:latest',
      host: host(),
      agent: { experimental: { bashDedup: true } },
    });
    setNextResponse({ content: 'ok' });
    const r = await spawnCliHeadless([], {
      stdin: 'hi\n',
      home: env.home,
      cwd: env.cwd,
    });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    // Welcome banner is on stdout in non-TTY runs; we should see the
    // bashDedup=on signal from the global config.
    assert.match(r.stdout, /bashDedup=on/);
  });

  it('project config overrides global config', async () => {
    writeGlobalConfig(env.home, {
      provider: 'ollama',
      model: 'test-model:latest',
      host: host(),
      agent: { experimental: { bashDedup: true } },
    });
    writeProjectConfig(env.cwd, {
      agent: { experimental: { bashDedup: false } },
    });
    // Trust the project config (otherwise hooks/mcp are stripped, but the
    // experimental flag inside `agent.experimental` is unaffected; project
    // trust is opt-in interactively. For headless and a brand-new project
    // dir, the project config still applies — verify the override wins).
    setNextResponse({ content: 'ok' });
    const r = await spawnCliHeadless([], {
      stdin: 'hi\n',
      home: env.home,
      cwd: env.cwd,
    });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /bashDedup=off/);
  });

  it('CLI flag wins over both config layers', async () => {
    writeGlobalConfig(env.home, {
      provider: 'ollama',
      model: 'test-model:latest',
      host: host(),
      agent: { experimental: { bashDedup: false } },
    });
    writeProjectConfig(env.cwd, {
      agent: { experimental: { bashDedup: false } },
    });
    setNextResponse({ content: 'ok' });
    const r = await spawnCliHeadless(['--bash-dedup'], {
      stdin: 'hi\n',
      home: env.home,
      cwd: env.cwd,
    });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /bashDedup=on/);
  });
});
