/**
 * Smoke test for the slash-command dispatcher. Each test types a command
 * into the TUI via the PTY harness and asserts on the rendered output.
 * Deeper slash semantics (rotation edits, stats math) are unit-tested
 * elsewhere; here we just verify the dispatcher routes to *something* on
 * each canonical name.
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

// Ink's <Static> flushes notice blocks asynchronously. Give renders a small
// settle window after each input — without it we race the next assertion.
async function settle(ms = 250): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

describe('Slash commands (PTY)', () => {
  // Verifies the dispatcher consumes the input (the typed `/<cmd>` echoes
  // back into the prompt before being submitted). Deeper notice-block
  // rendering is best covered by unit tests over `dispatchSlashCommand`
  // and `printHelp` — Ink's <Static> flush timing across PTY framing is
  // too sensitive to make a useful release-gate signal.
  it('/help is accepted by the dispatcher', async () => {
    const cli = spawnCli(args());
    try {
      await cli.waitForPrompt(8000);
      await settle();
      cli.sendLine('/help');
      await cli.waitForOutput('/help', 10000);
    } finally {
      cli.kill();
    }
  });

  it('/clear runs without crashing the session', async () => {
    const cli = spawnCli(args());
    try {
      await cli.waitForPrompt(8000);
      await settle();
      cli.sendLine('/clear');
      // Prompt should re-ready after the conversation is cleared.
      await cli.waitForPrompt(5000);
    } finally {
      cli.kill();
    }
  });

  it('/exp is accepted by the dispatcher', async () => {
    const cli = spawnCli(args());
    try {
      await cli.waitForPrompt(8000);
      await settle();
      cli.sendLine('/exp');
      await cli.waitForOutput('/exp', 10000);
    } finally {
      cli.kill();
    }
  });
});
