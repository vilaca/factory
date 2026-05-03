import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  startMockServer,
  stopMockServer,
  setNextResponse,
  setNextResponses,
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Project root (from dist-test/test/ -> ../../)
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

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

  it('--help shows huggingface examples', async () => {
    const cli = spawnCli(['--help']);
    try {
      const output = await cli.waitForOutput('huggingface', 5000);
      assert.ok(output.includes('huggingface'));
    } finally {
      cli.kill();
    }
  });

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

  it('resumes the last session model when Enter is pressed and it is still available', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-session-home-'));
    const firstCli = spawnCli(cliArgs(), { HOME: homeDir });
    try {
      await firstCli.waitForOutput('> ', 5000);
    } finally {
      firstCli.kill();
    }

    const secondCli = spawnCli(['--host', `http://127.0.0.1:${mockPort}`], { HOME: homeDir });
    try {
      const output = await secondCli.waitForOutput('Select a provider', 5000);
      assert.ok(output.includes('test-model:latest'));
      secondCli.send('');
      const ready = await secondCli.waitForOutput('> ', 5000);
      assert.ok(ready.includes('test-model:latest'));
      assert.ok(!ready.includes('Select a model'));
    } finally {
      secondCli.kill();
      fs.rmSync(homeDir, { recursive: true, force: true });
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

// ─── Slash commands ─────────────────────────────────────────────────────

describe('Slash commands', () => {
  it('/help shows available commands', async () => {
    const cli = spawnCli(cliArgs());
    try {
      await cli.waitForOutput('> ', 5000);
      cli.send('/help');
      const output = await cli.waitForOutput('Commands:', 5000);
      assert.ok(output.includes('/exit'));
      assert.ok(output.includes('/clear'));
      assert.ok(output.includes('/model'));
    } finally {
      cli.kill();
    }
  });

  it('/clear confirms conversation cleared', async () => {
    const cli = spawnCli(cliArgs());
    try {
      await cli.waitForOutput('> ', 5000);
      cli.send('/clear');
      const output = await cli.waitForOutput('Conversation cleared', 5000);
      assert.ok(output.includes('Conversation cleared'));
    } finally {
      cli.kill();
    }
  });

  it('/model shows current model', async () => {
    const cli = spawnCli(cliArgs());
    try {
      await cli.waitForOutput('> ', 5000);
      cli.send('/model');
      const output = await cli.waitForOutput('Current model:', 5000);
      assert.ok(output.includes('test-model:latest'));
    } finally {
      cli.kill();
    }
  });

  it('/model <name> switches model', async () => {
    const cli = spawnCli(cliArgs());
    try {
      await cli.waitForOutput('> ', 5000);
      cli.send('/model new-model');
      const output = await cli.waitForOutput('Model switched', 5000);
      assert.ok(output.includes('new-model'));
    } finally {
      cli.kill();
    }
  });

  it('unknown command shows error', async () => {
    const cli = spawnCli(cliArgs());
    try {
      await cli.waitForOutput('> ', 5000);
      cli.send('/foobar');
      const output = await cli.waitForOutput('Unknown command', 5000);
      assert.ok(output.includes('/foobar'));
    } finally {
      cli.kill();
    }
  });
});

// ─── Chat - plain text ─────────────────────────────────────────────────

describe('Chat - plain text response', () => {
  it('sends user message and streams back response', async () => {
    setNextResponse({ content: 'Hello! I am your coding assistant.' });

    const cli = spawnCli(cliArgs());
    try {
      await cli.waitForOutput('> ', 5000);
      cli.send('hi there');
      const output = await cli.waitForOutput('coding assistant', 10000);
      assert.ok(output.includes('Hello!'));
    } finally {
      cli.kill();
    }
  });
});

// ─── Chat - tool calls ─────────────────────────────────────────────────

describe('Chat - tool calls', () => {
  it('executes Read tool when user allows', async () => {
    const tmpFile = path.join(os.tmpdir(), `oc-read-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'line one\nline two\nline three\n');

    try {
      setNextResponses([
        {
          content: 'Let me read that file.',
          tool_calls: [{
            function: { name: 'Read', arguments: { file_path: tmpFile } },
          }],
        },
        { content: 'The file contains three lines.' },
      ]);

      const cli = spawnCli(cliArgs());
      try {
        await cli.waitForOutput('> ', 5000);
        cli.send('read the test file');
        // Wait for the tool call display (uses ▶ prefix)
        await cli.waitForOutput('file_path:', 10000);
        cli.send('y');
        const output = await cli.waitForOutput('three lines', 10000);
        assert.ok(output.includes('line one'));
        assert.ok(output.includes('line two'));
      } finally {
        cli.kill();
      }
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('handles tool call denial', async () => {
    setNextResponses([
      {
        content: 'Let me run a command.',
        tool_calls: [{
          function: { name: 'Bash', arguments: { command: 'echo hello' } },
        }],
      },
      { content: 'The command was denied, I understand.' },
    ]);

    const cli = spawnCli(cliArgs());
    try {
      await cli.waitForOutput('> ', 5000);
      cli.send('run echo hello');
      await cli.waitForOutput('command:', 10000);
      cli.send('n');
      const output = await cli.waitForOutput('denied', 10000);
      assert.ok(output.includes('denied'));
    } finally {
      cli.kill();
    }
  });

  it('executes Write tool and creates file', async () => {
    const tmpFile = path.join(os.tmpdir(), `oc-write-${Date.now()}.txt`);

    try {
      setNextResponses([
        {
          tool_calls: [{
            function: { name: 'Write', arguments: { file_path: tmpFile, content: 'hello from factory' } },
          }],
        },
        { content: 'File created successfully.' },
      ]);

      const cli = spawnCli(cliArgs());
      try {
        await cli.waitForOutput('> ', 5000);
        cli.send('create a file');
        await cli.waitForOutput('file_path:', 10000);
        cli.send('y');
        await cli.waitForOutput('File created', 10000);
        assert.ok(fs.existsSync(tmpFile));
        assert.strictEqual(fs.readFileSync(tmpFile, 'utf-8'), 'hello from factory');
      } finally {
        cli.kill();
      }
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  it('executes Edit tool and modifies file', async () => {
    const tmpFile = path.join(os.tmpdir(), `oc-edit-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'hello world\nfoo bar\n');

    try {
      setNextResponses([
        {
          tool_calls: [{
            function: {
              name: 'Edit',
              arguments: { file_path: tmpFile, old_string: 'foo bar', new_string: 'baz qux' },
            },
          }],
        },
        { content: 'Edit applied.' },
      ]);

      const cli = spawnCli(cliArgs());
      try {
        await cli.waitForOutput('> ', 5000);
        cli.send('edit the file');
        await cli.waitForOutput('old_string:', 10000);
        cli.send('y');
        await cli.waitForOutput('Edit applied', 10000);
        const content = fs.readFileSync(tmpFile, 'utf-8');
        assert.ok(content.includes('baz qux'));
        assert.ok(!content.includes('foo bar'));
      } finally {
        cli.kill();
      }
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  it('executes Bash tool and returns output', async () => {
    setNextResponses([
      {
        tool_calls: [{
          function: { name: 'Bash', arguments: { command: 'echo "e2e-test-output"' } },
        }],
      },
      { content: 'Command executed.' },
    ]);

    const cli = spawnCli(cliArgs());
    try {
      await cli.waitForOutput('> ', 5000);
      cli.send('run echo');
      await cli.waitForOutput('command:', 10000);
      cli.send('y');
      const output = await cli.waitForOutput('e2e-test-output', 10000);
      assert.ok(output.includes('e2e-test-output'));
    } finally {
      cli.kill();
    }
  });

  it('executes Glob tool and finds files', async () => {
    setNextResponses([
      {
        tool_calls: [{
          function: { name: 'Glob', arguments: { pattern: '*.json', path: PROJECT_ROOT } },
        }],
      },
      { content: 'Found the files.' },
    ]);

    const cli = spawnCli(cliArgs());
    try {
      await cli.waitForOutput('> ', 5000);
      cli.send('find json files');
      await cli.waitForOutput('pattern:', 10000);
      cli.send('y');
      const output = await cli.waitForOutput('package.json', 10000);
      assert.ok(output.includes('package.json'));
    } finally {
      cli.kill();
    }
  });

  it('executes Grep tool and searches content', async () => {
    const tmpFile = path.join(os.tmpdir(), `oc-grep-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'needle in a haystack\nanother line\n');

    try {
      setNextResponses([
        {
          tool_calls: [{
            function: { name: 'Grep', arguments: { pattern: 'needle', path: tmpFile } },
          }],
        },
        { content: 'Found the match.' },
      ]);

      const cli = spawnCli(cliArgs());
      try {
        await cli.waitForOutput('> ', 5000);
        cli.send('search for needle');
        await cli.waitForOutput('pattern:', 10000);
        cli.send('y');
        const output = await cli.waitForOutput('Found the match', 10000);
        assert.ok(output.includes(tmpFile) || output.includes('needle'));
      } finally {
        cli.kill();
      }
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });
});

// ─── Permission - allow all ─────────────────────────────────────────────

describe('Permission - allow all', () => {
  it('auto-allows subsequent calls after allow-all', async () => {
    const tmpFile1 = path.join(os.tmpdir(), `oc-perm1-${Date.now()}.txt`);
    const tmpFile2 = path.join(os.tmpdir(), `oc-perm2-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile1, 'file one content\n');
    fs.writeFileSync(tmpFile2, 'file two content\n');

    try {
      setNextResponses([
        {
          tool_calls: [{
            function: { name: 'Read', arguments: { file_path: tmpFile1 } },
          }],
        },
        { content: 'Read first file.' },
      ]);

      const cli = spawnCli(cliArgs());
      try {
        await cli.waitForOutput('> ', 5000);
        cli.send('read both files');

        // First tool call — allow all
        await cli.waitForOutput('file_path:', 10000);
        cli.send('a');

        await cli.waitForOutput('file one content', 10000);

        // Second request — Read should be auto-allowed (no prompt)
        setNextResponses([
          {
            tool_calls: [{
              function: { name: 'Read', arguments: { file_path: tmpFile2 } },
            }],
          },
          { content: 'Both files read successfully.' },
        ]);

        cli.send('now read the second file');
        const output = await cli.waitForOutput('file two content', 10000);
        assert.ok(output.includes('file two content'));
      } finally {
        cli.kill();
      }
    } finally {
      if (fs.existsSync(tmpFile1)) fs.unlinkSync(tmpFile1);
      if (fs.existsSync(tmpFile2)) fs.unlinkSync(tmpFile2);
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

  it('Read tool handles non-existent file', async () => {
    setNextResponses([
      {
        tool_calls: [{
          function: { name: 'Read', arguments: { file_path: '/nonexistent/path.txt' } },
        }],
      },
      { content: 'The file does not exist.' },
    ]);

    const cli = spawnCli(cliArgs());
    try {
      await cli.waitForOutput('> ', 5000);
      cli.send('read a missing file');
      await cli.waitForOutput('file_path:', 10000);
      cli.send('y');
      const output = await cli.waitForOutput('Error reading', 10000);
      assert.ok(output.includes('Error reading'));
    } finally {
      cli.kill();
    }
  });

  it('Edit tool handles string not found', async () => {
    const tmpFile = path.join(os.tmpdir(), `oc-edit-err-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'some content\n');

    try {
      setNextResponses([
        {
          tool_calls: [{
            function: {
              name: 'Edit',
              arguments: { file_path: tmpFile, old_string: 'nonexistent', new_string: 'x' },
            },
          }],
        },
        { content: 'The string was not found.' },
      ]);

      const cli = spawnCli(cliArgs());
      try {
        await cli.waitForOutput('> ', 5000);
        cli.send('edit something');
        await cli.waitForOutput('old_string:', 10000);
        cli.send('y');
        const output = await cli.waitForOutput('not found', 10000);
        assert.ok(output.includes('not found'));
      } finally {
        cli.kill();
      }
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });
});
