import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  startMockServer,
  stopMockServer,
} from './mock-ollama-server.js';
import {
  startMockCopilotServer,
  stopMockCopilotServer,
} from './mock-copilot-server.js';
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
  return ['--provider', 'ollama', '--model', 'test-model:latest', '--host', `http://127.0.0.1:${mockPort}`, ...extra];
}

// ─── CLI flags ──────────────────────────────────────────────────────────

describe('CLI flags', () => {
  // TODO: convert to unit test — call printUsage() from src/cli/args.ts and
  // assert on the captured output. No process spawn needed.
  it('--help shows usage information', async () => {
    const cli = spawnCli(['--help']);
    try {
      const output = await cli.waitForOutput('Usage:', 5000);
      assert.ok(output.includes('factory'));
      assert.ok(output.includes('--model'));
      assert.ok(output.includes('--provider'));
    } finally {
      cli.kill();
    }
  });

  // TODO: convert to unit test — same as above, just a different assertion on
  // printUsage() output.
  it('--help shows huggingface examples', async () => {
    const cli = spawnCli(['--help']);
    try {
      const output = await cli.waitForOutput('huggingface', 5000);
      assert.ok(output.includes('huggingface'));
    } finally {
      cli.kill();
    }
  });

  // TODO: convert to unit test — same as above, just a different assertion on
  // printUsage() output.
  it('--help shows copilot examples', async () => {
    const cli = spawnCli(['--help']);
    try {
      const output = await cli.waitForOutput('copilot', 5000);
      assert.ok(output.includes('gpt-4.1'));
    } finally {
      cli.kill();
    }
  });
});

// ─── Startup ────────────────────────────────────────────────────────────

describe('Startup and welcome', () => {
  it('shows welcome banner with model name and cwd', async () => {
    const cli = spawnCli(cliArgs());
    try {
      const output = await cli.waitForOutput('test-model:latest', 5000);
      assert.ok(output.includes('factory'));
      assert.ok(output.includes('Exp:'));
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

  it('shows model picker when no model specified', async () => {
    const cli = spawnCli(['--provider', 'ollama', '--host', `http://127.0.0.1:${mockPort}`]);
    try {
      const output = await cli.waitForOutput('Select a model', 5000);
      assert.ok(output.includes('test-model:latest'));
      assert.ok(output.includes('another-model:latest'));
    } finally {
      cli.kill();
    }
  });

  it('prompts for provider selection when no provider is configured', async () => {
    const cli = spawnCli(
      ['--model', 'test-model:latest', '--host', `http://127.0.0.1:${mockPort}`],
    );
    try {
      const output = await cli.waitForOutput('GitHub Copilot', 5000);
      assert.ok(output.includes('Select a provider'));
      assert.ok(output.includes('Ollama'));
      assert.ok(output.includes('HuggingFace'));
      assert.ok(output.includes('GitHub Copilot'));
      cli.send('1');
      const ready = await cli.waitForOutput('Tools:', 5000);
      assert.ok(ready.includes('Tools:'));
    } finally {
      cli.kill();
    }
  });

  it('hides Ollama when the Ollama service is not reachable', async () => {
    const cli = spawnCli(
      ['--host', `http://127.0.0.1:${mockCopilotPort}`],
      {
        GITHUB_COPILOT_API_KEY: 'ghu_test_token',
        FACTORY_GITHUB_API_BASE_URL: `http://127.0.0.1:${mockCopilotPort}`,
      },
    );
    try {
      const output = await cli.waitForOutput('Select a provider', 5000);
      assert.ok(!output.includes('Ollama'));
      assert.ok(output.includes('GitHub Copilot'));
    } finally {
      cli.kill();
    }
  });

  it('prompts for a Copilot token and reuses the saved token on the next run', async () => {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-copilot-config-'));
    const args = ['--model', 'gpt-4.1', '--host', `http://127.0.0.1:${mockCopilotPort}`];

    const firstCli = spawnCli(args, {
      XDG_CONFIG_HOME: configHome,
      FACTORY_GITHUB_LOGIN_BASE_URL: `http://127.0.0.1:${mockCopilotPort}`,
      FACTORY_GITHUB_API_BASE_URL: `http://127.0.0.1:${mockCopilotPort}`,
    });
    try {
      await firstCli.waitForOutput('Select a provider', 5000);
      firstCli.send('2');
      await firstCli.waitForOutput('GitHub Copilot sign-in required', 5000);
      await firstCli.waitForOutput('Enter code:', 5000);
      const output = await firstCli.waitForOutput('Tools:', 5000);
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
      await secondCli.waitForOutput('Select a provider', 5000);
      secondCli.send('2');
      const output = await secondCli.waitForOutput('Tools:', 5000);
      assert.ok(!output.includes('GitHub Copilot sign-in required'));
      assert.ok(output.includes('Tools:'));
    } finally {
      secondCli.kill();
      fs.rmSync(configHome, { recursive: true, force: true });
    }
  });
});

// ─── Error handling ─────────────────────────────────────────────────────

describe('Error handling', () => {
  it('shows error when Ollama is not running', async () => {
    const cli = spawnCli(['--provider', 'ollama', '--model', 'test-model', '--host', 'http://127.0.0.1:19999']);
    try {
      const output = await cli.waitForOutput('Cannot connect', 10000);
      assert.ok(output.includes('Cannot connect'));
    } finally {
      cli.kill();
    }
  });

  // TODO: convert to unit test — assert that createProvider('foobar') from
  // src/providers/registry.ts throws with "Unknown provider".
  it('shows error for unknown provider', async () => {
    const cli = spawnCli(['--provider', 'foobar']);
    try {
      const output = await cli.waitForOutput('Unknown provider', 5000);
      assert.ok(output.includes('foobar'));
    } finally {
      cli.kill();
    }
  });

  it('prompts for a HuggingFace token and saves it for the next run', async () => {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-hf-config-'));
    const cli = spawnCli(
      ['--provider', 'huggingface'],
      { XDG_CONFIG_HOME: configHome, HF_TOKEN: '', HUGGING_FACE_HUB_TOKEN: '' },
    );
    try {
      await cli.waitForOutput('HuggingFace API token required', 5000);
      cli.send('hf_test_token');
      const output = await cli.waitForOutput('Saved HuggingFace credentials', 5000);
      assert.ok(output.includes('Saved HuggingFace credentials'));
    } finally {
      cli.kill();
      const configPath = path.join(configHome, 'factory', 'config.json');
      const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      assert.strictEqual(savedConfig.huggingfaceToken, 'hf_test_token');
      fs.rmSync(configHome, { recursive: true, force: true });
    }
  });
});
