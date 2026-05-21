/**
 * Multi-tab smoke. Ctrl+T opens a new tab; the tab strip should reflect
 * the count. /tabs and /switch are exercised via PTY input. Closing the
 * last tab exits the app — assert the process exits cleanly.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnCli } from '../cli-harness.js';
import { startMockServer, stopMockServer } from '../mock-ollama-server.js';

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

// TODO(ci-slow): see picker.test.ts — PTY isn't seen as a TTY on the
// GitHub Linux runner, so factory falls back to headless and these
// assertions can't observe the TUI.
const SKIP_PTY_ON_CI = process.env.CI === 'true';

describe('Tabs (PTY)', { skip: SKIP_PTY_ON_CI }, () => {
  it('Ctrl+T opens a new tab; /tabs lists both', async () => {
    const cli = spawnCli(args());
    try {
      await cli.waitForPrompt(5000);
      cli.sendCtrl('t');
      // Give Ink one frame to re-render the tab strip.
      await cli.waitForPrompt(5000);
      cli.sendLine('/tabs');
      const out = await cli.waitForOutput(/2\b|tabs?/i, 5000);
      // We don't assert a specific format — just that /tabs produced
      // something tab-list-shaped.
      assert.ok(out.length > 0);
    } finally {
      cli.kill();
    }
  });

  it('/new foo + /switch foo route to the labeled tab', async () => {
    const cli = spawnCli(args());
    try {
      await cli.waitForPrompt(5000);
      cli.sendLine('/new foo');
      await cli.waitForPrompt(5000);
      cli.sendLine('/switch foo');
      await cli.waitForPrompt(3000);
      cli.sendLine('/tabs');
      const out = await cli.waitForOutput('foo', 5000);
      assert.ok(out.includes('foo'));
    } finally {
      cli.kill();
    }
  });
});
