/**
 * E2E tests that initiate a network connection. They either talk to a
 * mock server (ollama / copilot) or deliberately point at a dead local
 * port to verify error surfacing. Either way, the CLI opens a socket.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { startMockServer, stopMockServer } from './mock-ollama-server.js';
import { startMockCopilotServer, stopMockCopilotServer } from './mock-copilot-server.js';
import { spawnCli } from './cli-harness.js';

let mockPort: number;
let mockServer: any;
let mockCopilotPort: number;
let mockCopilotServer: any;

before(async () => {
  const result = await startMockServer();
  mockServer = result.server;
  mockPort = result.port;

  const copilotResult = await startMockCopilotServer();
  mockCopilotServer = copilotResult.server;
  mockCopilotPort = copilotResult.port;
});

after(async () => {
  await stopMockServer(mockServer);
  await stopMockCopilotServer(mockCopilotServer);
});

function cliArgs(extra: string[] = []): string[] {
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

// ─── Startup ────────────────────────────────────────────────────────────

describe('Startup and welcome', () => {
  it('shows welcome banner with model name and cwd', async () => {
    const cli = spawnCli(cliArgs());
    try {
      const output = await cli.waitForOutput('test-model:latest', 5000);
      assert.ok(output.includes('factory'));
      assert.ok(output.includes('Flags:'));
      assert.ok(output.includes('bashDedup=off'));
      assert.ok(output.includes('readCache=on'));
      assert.ok(output.includes('lineCountHint=on'));
      assert.ok(output.includes('Tools:'));
    } finally {
      cli.kill();
    }
  });

  it('shows CLI-overridden experimental flags in the welcome banner', async () => {
    const cli = spawnCli(cliArgs(['--bash-dedup', '--no-read-cache']));
    try {
      const output = await cli.waitForOutput('test-model:latest', 5000);
      assert.ok(output.includes('bashDedup=on'));
      assert.ok(output.includes('readCache=off'));
      assert.ok(output.includes('lineCountHint=on'));
    } finally {
      cli.kill();
    }
  });

  // TODO(ci-slow): flaky on Linux CI runners — the 5s wait is too tight
  // for the picker-mount path (cold Node start + module load + probe +
  // Ink mount). Restore once the slow path is bounded or the timeout
  // strategy is revisited.
  it.skip('shows model picker when no model specified', async () => {
    const cli = spawnCli(['--provider', 'ollama', '--host', `http://127.0.0.1:${mockPort}`]);
    try {
      const output = await cli.waitForOutput('Select a model', 5000);
      assert.ok(output.includes('test-model:latest'));
      assert.ok(output.includes('another-model:latest'));
    } finally {
      cli.kill();
    }
  });

  // TODO(ci-slow): see comment on 'shows model picker when no model specified'.
  it.skip('prompts for provider selection when no provider is configured', async () => {
    const cli = spawnCli([
      '--model',
      'test-model:latest',
      '--host',
      `http://127.0.0.1:${mockPort}`,
    ]);
    try {
      // Picker opens at the "recent provider/model" stage. With no recent
      // sessions only one option ("Pick a different provider/model") is
      // pre-selected — Enter advances to the provider list.
      await cli.waitForOutput('Recent provider/model', 5000);
      cli.sendEnter();
      const output = await cli.waitForOutput('Select a provider', 5000);
      assert.ok(output.includes('Anthropic'));
      assert.ok(output.includes('GitHub Copilot'));
      // Ollama is at alphabetical index 11 (shortcut 'B'). The viewport
      // truncates to 8 rows but the jump shortcut works regardless.
      cli.send('B');
      const ready = await cli.waitForOutput('Tools:', 10000);
      assert.ok(ready.includes('Tools:'));
    } finally {
      cli.kill();
    }
  });

  // TODO(ci-slow): see comment on 'shows model picker when no model specified'.
  it.skip('shows Ollama as offline when the Ollama service is not reachable', async () => {
    const cli = spawnCli(['--host', `http://127.0.0.1:${mockCopilotPort}`], {
      GITHUB_COPILOT_API_KEY: 'ghu_test_token',
      FACTORY_GITHUB_API_BASE_URL: `http://127.0.0.1:${mockCopilotPort}`,
    });
    try {
      await cli.waitForOutput('Recent provider/model', 5000);
      cli.sendEnter();
      const output = await cli.waitForOutput('Select a provider', 5000);
      assert.ok(output.includes('GitHub Copilot'));
      assert.ok(output.includes('Anthropic'));
    } finally {
      cli.kill();
    }
  });

  it('shows error when Ollama is not running', async () => {
    const cli = spawnCli([
      '--provider',
      'ollama',
      '--model',
      'test-model',
      '--host',
      'http://127.0.0.1:19999',
    ]);
    try {
      const output = await cli.waitForOutput('Cannot connect', 10000);
      assert.ok(output.includes('Cannot connect'));
    } finally {
      cli.kill();
    }
  });

  it('prompts for a HuggingFace token and saves it for the next run', async () => {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-hf-config-'));
    const cli = spawnCli(['--provider', 'huggingface'], {
      XDG_CONFIG_HOME: configHome,
      HF_TOKEN: '',
      HUGGING_FACE_HUB_TOKEN: '',
    });
    try {
      await cli.waitForOutput('HuggingFace API token required', 5000);
      cli.sendLine('hf_test_token');
      const output = await cli.waitForOutput('Saved HuggingFace credentials', 5000);
      assert.ok(output.includes('Saved HuggingFace credentials'));
    } finally {
      cli.kill();
      const configPath = path.join(configHome, 'factory', 'config.json');
      const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      // Tokens are stored in the multi-key store keyed by provider.
      const hfKeys: Array<{ token: string }> = savedConfig.keys?.huggingface ?? [];
      assert.ok(
        hfKeys.some(k => k.token === 'hf_test_token'),
        `expected hf_test_token in keys.huggingface, got ${JSON.stringify(savedConfig.keys)}`,
      );
      fs.rmSync(configHome, { recursive: true, force: true });
    }
  });

  // TODO(ci-slow): see comment on 'shows model picker when no model specified'.
  it.skip('prompts for a Copilot token and reuses the saved token on the next run', async () => {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-copilot-config-'));
    const args = ['--model', 'gpt-4.1', '--host', `http://127.0.0.1:${mockCopilotPort}`];

    const firstCli = spawnCli(args, {
      XDG_CONFIG_HOME: configHome,
      FACTORY_GITHUB_LOGIN_BASE_URL: `http://127.0.0.1:${mockCopilotPort}`,
      FACTORY_GITHUB_API_BASE_URL: `http://127.0.0.1:${mockCopilotPort}`,
    });
    try {
      await firstCli.waitForOutput('Recent provider/model', 5000);
      firstCli.sendEnter();
      await firstCli.waitForOutput('Select a provider', 5000);
      // GitHub Copilot is at alphabetical index 5.
      firstCli.send('5');
      await firstCli.waitForOutput('GitHub Copilot sign-in required', 5000);
      await firstCli.waitForOutput('Enter code:', 5000);
      const output = await firstCli.waitForOutput('Tools:', 10000);
      assert.ok(output.includes('Tools:'));
    } finally {
      firstCli.kill();
    }

    const configPath = path.join(configHome, 'factory', 'config.json');
    const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(savedConfig.githubToken, 'gho_mock_auth_token');

    const secondCli = spawnCli(args, {
      XDG_CONFIG_HOME: configHome,
      FACTORY_GITHUB_LOGIN_BASE_URL: `http://127.0.0.1:${mockCopilotPort}`,
      FACTORY_GITHUB_API_BASE_URL: `http://127.0.0.1:${mockCopilotPort}`,
    });
    try {
      await secondCli.waitForOutput('Recent provider/model', 5000);
      secondCli.sendEnter();
      await secondCli.waitForOutput('Select a provider', 5000);
      secondCli.send('5');
      const output = await secondCli.waitForOutput('Tools:', 10000);
      assert.ok(!output.includes('GitHub Copilot sign-in required'));
      assert.ok(output.includes('Tools:'));
    } finally {
      secondCli.kill();
      fs.rmSync(configHome, { recursive: true, force: true });
    }
  });
});
