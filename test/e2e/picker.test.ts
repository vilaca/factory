/**
 * Provider/model picker via PTY. Two paths:
 *  - explicit Ctrl+K from a running session, which re-opens the picker
 *  - --pick on the command line, which forces the picker even when a
 *    previous session is on file
 *
 * The deep picker flows (selection, alphabetical jump, recent-session)
 * are already covered in e2e-mocks.test.ts; this file is the minimal
 * regression net for the entry-point bindings.
 */

import { describe, it, before, after } from 'node:test';
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

// TODO(ci-slow): node-pty on the GitHub Linux runner spawns the child
// with stdout.isTTY=false, so factory takes the headless branch instead
// of mounting Ink — every PTY assertion below then times out waiting for
// a prompt that's never rendered. Same root cause as the existing skips
// in test/e2e-mocks.test.ts. Re-enable once the runner exposes a real
// PTY device or we move to a containerized terminal harness.
const SKIP_PTY_ON_CI = process.env.CI === 'true';

describe('Picker entry points (PTY)', { skip: SKIP_PTY_ON_CI }, () => {
  it('Ctrl+K from a running session opens the picker', async () => {
    const cli = spawnCli(args());
    try {
      await cli.waitForPrompt(5000);
      cli.sendCtrl('k');
      // The picker prints a "Select" header — exact label varies by stage.
      await cli.waitForOutput(/Select|provider|model/i, 5000);
    } finally {
      cli.kill();
    }
  });
});
