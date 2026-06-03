import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  loadGlobalConfig,
  loadProjectConfig,
  loadProjectInstructions,
  loadScopedProjectInstructions,
  saveGlobalConfig,
} from '../../../../src/core/config/index.js';

async function withTempProject(
  configContent: string | null,
  fn: (cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-config-'));
  try {
    if (configContent !== null) {
      const dir = path.join(cwd, '.factory');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'config.json'), configContent);
    }
    await fn(cwd);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

describe('loadProjectConfig', () => {
  it('returns empty config when file is missing', async () => {
    await withTempProject(null, async cwd => {
      const cfg = await loadProjectConfig(cwd);
      assert.deepStrictEqual(cfg, {});
    });
  });

  it('parses a valid config', async () => {
    const content = JSON.stringify({
      provider: 'ollama',
      model: 'qwen3-coder:30b',
      huggingfaceToken: 'hf-test',
      openrouterToken: 'sk-or-v1-test',
      vercelToken: 'agw-test',
      opencodeZenToken: 'zen-test',
      googleAiStudioToken: 'gemini-test',
      googleAiStudioAuthMode: 'oauth',
      mistralToken: 'mistral-test',
      codestralToken: 'codestral-test',
      cerebrasToken: 'cerebras-test',
      groqToken: 'groq-test',
      cohereToken: 'cohere-test',
      workersAiToken: 'workersai-test',
      workersAiAccountId: 'workersai-account-test',
      agent: { compactionThreshold: 0.7, recencyWindow: 4 },
      permissions: { allowAll: ['Bash', 'Read'] },
    });
    await withTempProject(content, async cwd => {
      const cfg = await loadProjectConfig(cwd);
      assert.strictEqual(cfg.provider, 'ollama');
      assert.strictEqual(cfg.huggingfaceToken, 'hf-test');
      assert.strictEqual(cfg.openrouterToken, 'sk-or-v1-test');
      assert.strictEqual(cfg.vercelToken, 'agw-test');
      assert.strictEqual(cfg.opencodeZenToken, 'zen-test');
      assert.strictEqual(cfg.googleAiStudioToken, 'gemini-test');
      assert.strictEqual(cfg.googleAiStudioAuthMode, 'oauth');
      assert.strictEqual(cfg.mistralToken, 'mistral-test');
      assert.strictEqual(cfg.codestralToken, 'codestral-test');
      assert.strictEqual(cfg.cerebrasToken, 'cerebras-test');
      assert.strictEqual(cfg.groqToken, 'groq-test');
      assert.strictEqual(cfg.cohereToken, 'cohere-test');
      assert.strictEqual(cfg.workersAiToken, 'workersai-test');
      assert.strictEqual(cfg.workersAiAccountId, 'workersai-account-test');
      assert.deepStrictEqual(cfg.permissions?.allowAll, ['Bash', 'Read']);
    });
  });

  it('rejects malformed JSON with a path-aware error', async () => {
    await withTempProject('{"provider": "ollama",}', async cwd => {
      await assert.rejects(
        () => loadProjectConfig(cwd),
        (err: Error) => /config\.json: invalid JSON/.test(err.message),
      );
    });
  });

  it('rejects a top-level array', async () => {
    await withTempProject('[]', async cwd => {
      await assert.rejects(
        () => loadProjectConfig(cwd),
        (err: Error) => /top-level must be a JSON object/.test(err.message),
      );
    });
  });

  it('warns on unknown top-level fields without rejecting the load', async () => {
    // A typo like `permissons` (missing `i`) used to silently pass through —
    // the user thought their allowlist was active, but the field was dropped.
    // We warn loudly to stderr instead of hard-rejecting, because hard-reject
    // would prevent older builds from loading newer configs after upgrade.
    const original = process.stderr.write;
    const captured: string[] = [];
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (
      chunk: string,
    ) => {
      captured.push(chunk);
      return true;
    };
    try {
      await withTempProject(
        JSON.stringify({ provider: 'ollama', permissons: { allowAll: ['Bash'] } }),
        async cwd => {
          const cfg = await loadProjectConfig(cwd);
          // Load succeeds; the typo'd field is ignored, the valid one stuck.
          assert.strictEqual(cfg.provider, 'ollama');
          assert.strictEqual(cfg.permissions, undefined);
        },
      );
    } finally {
      (process.stderr as unknown as { write: (chunk: string) => boolean }).write =
        original as unknown as (chunk: string) => boolean;
    }
    const all = captured.join('');
    assert.match(all, /unknown top-level field/);
    assert.match(all, /permissons/);
    // The known-list should be in the suggestion so the user can spot the right name.
    assert.match(all, /permissions/);
  });

  it('rejects a non-string provider', async () => {
    await withTempProject('{"provider": 42}', async cwd => {
      await assert.rejects(
        () => loadProjectConfig(cwd),
        (err: Error) => /"provider" must be a string/.test(err.message),
      );
    });
  });

  it('rejects compactionThreshold outside 0-1', async () => {
    await withTempProject('{"agent": {"compactionThreshold": 1.5}}', async cwd => {
      await assert.rejects(
        () => loadProjectConfig(cwd),
        (err: Error) => /compactionThreshold.*between 0 and 1/.test(err.message),
      );
    });
  });

  it('rejects non-integer recencyWindow', async () => {
    await withTempProject('{"agent": {"recencyWindow": 2.5}}', async cwd => {
      await assert.rejects(
        () => loadProjectConfig(cwd),
        (err: Error) => /recencyWindow.*non-negative integer/.test(err.message),
      );
    });
  });

  it('rejects non-array allowAll', async () => {
    await withTempProject('{"permissions": {"allowAll": "Bash"}}', async cwd => {
      await assert.rejects(
        () => loadProjectConfig(cwd),
        (err: Error) => /allowAll.*array of strings/.test(err.message),
      );
    });
  });

  it('rejects an invalid Google AI Studio auth mode', async () => {
    await withTempProject('{"googleAiStudioAuthMode": "token"}', async cwd => {
      await assert.rejects(
        () => loadProjectConfig(cwd),
        (err: Error) => /googleAiStudioAuthMode.*"api-key" or "oauth"/.test(err.message),
      );
    });
  });

  it('tolerates unknown top-level fields', async () => {
    await withTempProject('{"futureField": 123, "provider": "ollama"}', async cwd => {
      const cfg = await loadProjectConfig(cwd);
      assert.strictEqual(cfg.provider, 'ollama');
    });
  });
});

describe('loadProjectInstructions', () => {
  it('returns null when no instruction sources exist', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-instr-'));
    try {
      assert.strictEqual(await loadProjectInstructions(cwd), null);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('reads .factory/AGENTS.md at startup', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-instr-'));
    try {
      await fs.mkdir(path.join(cwd, '.factory'), { recursive: true });
      await fs.writeFile(path.join(cwd, '.factory/AGENTS.md'), 'agent-rules');
      const out = await loadProjectInstructions(cwd);
      assert.ok(out !== null);
      assert.match(out, /^## From \.factory\/AGENTS\.md\n\nagent-rules/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('reads .factory/INSTRUCTIONS.md with a path-prefixed header', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-instr-'));
    try {
      await fs.mkdir(path.join(cwd, '.factory'), { recursive: true });
      await fs.writeFile(path.join(cwd, '.factory/INSTRUCTIONS.md'), 'be tidy');
      const out = await loadProjectInstructions(cwd);
      assert.ok(out !== null);
      assert.match(out, /^## From \.factory\/INSTRUCTIONS\.md\n\nbe tidy/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not load AGENTS.md/CLAUDE.md/.cursorrules at startup', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-instr-'));
    try {
      await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'agents-body');
      await fs.writeFile(path.join(cwd, 'CLAUDE.md'), 'claude-body');
      await fs.writeFile(path.join(cwd, '.cursorrules'), 'cursor-body');
      const out = await loadProjectInstructions(cwd);
      assert.strictEqual(out, null);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns null when startup instruction file alone exceeds the size cap', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-instr-'));
    try {
      const big = 'x'.repeat(20 * 1024);
      await fs.mkdir(path.join(cwd, '.factory'), { recursive: true });
      await fs.writeFile(path.join(cwd, '.factory/INSTRUCTIONS.md'), big);
      const out = await loadProjectInstructions(cwd);
      assert.strictEqual(out, null);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('loadScopedProjectInstructions', () => {
  it('walks touched dirs to project root and orders root → child', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-scoped-'));
    try {
      const nested = path.join(cwd, 'src', 'feature');
      await fs.mkdir(nested, { recursive: true });
      await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'root-agents');
      await fs.writeFile(path.join(cwd, 'src', 'CLAUDE.md'), 'src-claude');
      await fs.writeFile(path.join(nested, '.cursorrules'), 'feature-cursor');

      const out = await loadScopedProjectInstructions(cwd, [nested]);
      assert.ok(out !== null);
      const idxRoot = out.indexOf('## From AGENTS.md');
      const idxSrc = out.indexOf(`## From src${path.sep}CLAUDE.md`);
      const idxFeature = out.indexOf(`## From src${path.sep}feature${path.sep}.cursorrules`);
      assert.ok(idxRoot >= 0 && idxSrc > idxRoot && idxFeature > idxSrc);
      assert.match(out, /root-agents/);
      assert.match(out, /src-claude/);
      assert.match(out, /feature-cursor/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not climb above project root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-scoped-root-'));
    const outside = path.join(path.dirname(root), 'outside-sentinel');
    try {
      await fs.writeFile(path.join(path.dirname(root), 'AGENTS.md'), 'outside');
      const out = await loadScopedProjectInstructions(root, [outside]);
      assert.strictEqual(out, null);
    } finally {
      await fs.rm(path.join(path.dirname(root), 'AGENTS.md'), { force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('truncates scoped instructions with a cap note', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-scoped-cap-'));
    try {
      const nested = path.join(cwd, 'pkg');
      await fs.mkdir(nested, { recursive: true });
      await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'root');
      await fs.writeFile(path.join(nested, 'CLAUDE.md'), 'x'.repeat(20 * 1024));
      const out = await loadScopedProjectInstructions(cwd, [nested]);
      assert.ok(out !== null);
      assert.match(out, /truncated at 16384 bytes/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('saveGlobalConfig', () => {
  it('persists a HuggingFace token in the global config', async () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-global-config-'));
    process.env.XDG_CONFIG_HOME = configHome;

    try {
      await saveGlobalConfig({ huggingfaceToken: 'hf_test_token' });
      const cfg = await loadGlobalConfig();
      assert.strictEqual(cfg.huggingfaceToken, 'hf_test_token');
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
      await fs.rm(configHome, { recursive: true, force: true });
    }
  });

  it('persists a Copilot token in the global config', async () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-global-config-'));
    process.env.XDG_CONFIG_HOME = configHome;

    try {
      await saveGlobalConfig({ copilotToken: 'ghu_test_token' });
      const cfg = await loadGlobalConfig();
      assert.strictEqual(cfg.copilotToken, 'ghu_test_token');
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
      await fs.rm(configHome, { recursive: true, force: true });
    }
  });

  it('persists a Google AI Studio token in the global config', async () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-global-config-'));
    process.env.XDG_CONFIG_HOME = configHome;

    try {
      await saveGlobalConfig({ googleAiStudioToken: 'gemini_test_token' });
      const cfg = await loadGlobalConfig();
      assert.strictEqual(cfg.googleAiStudioToken, 'gemini_test_token');
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
      await fs.rm(configHome, { recursive: true, force: true });
    }
  });

  it('persists a Vercel AI Gateway token in the global config', async () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-global-config-'));
    process.env.XDG_CONFIG_HOME = configHome;

    try {
      await saveGlobalConfig({ vercelToken: 'agw_test_token' });
      const cfg = await loadGlobalConfig();
      assert.strictEqual(cfg.vercelToken, 'agw_test_token');
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
      await fs.rm(configHome, { recursive: true, force: true });
    }
  });

  it('persists an OpenCode Zen token in the global config', async () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-global-config-'));
    process.env.XDG_CONFIG_HOME = configHome;

    try {
      await saveGlobalConfig({ opencodeZenToken: 'zen_test_token' });
      const cfg = await loadGlobalConfig();
      assert.strictEqual(cfg.opencodeZenToken, 'zen_test_token');
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
      await fs.rm(configHome, { recursive: true, force: true });
    }
  });

  it('persists a Google AI Studio auth mode in the global config', async () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-global-config-'));
    process.env.XDG_CONFIG_HOME = configHome;

    try {
      await saveGlobalConfig({ googleAiStudioAuthMode: 'oauth' });
      const cfg = await loadGlobalConfig();
      assert.strictEqual(cfg.googleAiStudioAuthMode, 'oauth');
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
      await fs.rm(configHome, { recursive: true, force: true });
    }
  });

  it('persists a Mistral token in the global config', async () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-global-config-'));
    process.env.XDG_CONFIG_HOME = configHome;

    try {
      await saveGlobalConfig({ mistralToken: 'mistral_test_token' });
      const cfg = await loadGlobalConfig();
      assert.strictEqual(cfg.mistralToken, 'mistral_test_token');
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
      await fs.rm(configHome, { recursive: true, force: true });
    }
  });

  it('persists a Codestral token in the global config', async () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-global-config-'));
    process.env.XDG_CONFIG_HOME = configHome;

    try {
      await saveGlobalConfig({ codestralToken: 'codestral_test_token' });
      const cfg = await loadGlobalConfig();
      assert.strictEqual(cfg.codestralToken, 'codestral_test_token');
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
      await fs.rm(configHome, { recursive: true, force: true });
    }
  });

  it('persists a Cerebras token in the global config', async () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-global-config-'));
    process.env.XDG_CONFIG_HOME = configHome;

    try {
      await saveGlobalConfig({ cerebrasToken: 'cerebras_test_token' });
      const cfg = await loadGlobalConfig();
      assert.strictEqual(cfg.cerebrasToken, 'cerebras_test_token');
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
      await fs.rm(configHome, { recursive: true, force: true });
    }
  });

  it('persists a Groq token in the global config', async () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-global-config-'));
    process.env.XDG_CONFIG_HOME = configHome;

    try {
      await saveGlobalConfig({ groqToken: 'groq_test_token' });
      const cfg = await loadGlobalConfig();
      assert.strictEqual(cfg.groqToken, 'groq_test_token');
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
      await fs.rm(configHome, { recursive: true, force: true });
    }
  });

  it('persists a Cohere token in the global config', async () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-global-config-'));
    process.env.XDG_CONFIG_HOME = configHome;

    try {
      await saveGlobalConfig({ cohereToken: 'cohere_test_token' });
      const cfg = await loadGlobalConfig();
      assert.strictEqual(cfg.cohereToken, 'cohere_test_token');
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
      await fs.rm(configHome, { recursive: true, force: true });
    }
  });

  it('persists Workers AI credentials in the global config', async () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-global-config-'));
    process.env.XDG_CONFIG_HOME = configHome;

    try {
      await saveGlobalConfig({
        workersAiToken: 'workersai_test_token',
        workersAiAccountId: 'workersai_account_test',
      });
      const cfg = await loadGlobalConfig();
      assert.strictEqual(cfg.workersAiToken, 'workersai_test_token');
      assert.strictEqual(cfg.workersAiAccountId, 'workersai_account_test');
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
      await fs.rm(configHome, { recursive: true, force: true });
    }
  });

  it('writes config file with mode 0o600', { skip: process.platform === 'win32' }, async () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-global-config-'));
    process.env.XDG_CONFIG_HOME = configHome;

    try {
      await saveGlobalConfig({ token: 'secret' });
      const stat = await fs.stat(path.join(configHome, 'factory', 'config.json'));
      assert.strictEqual(stat.mode & 0o777, 0o600);
      const dirStat = await fs.stat(path.join(configHome, 'factory'));
      assert.strictEqual(dirStat.mode & 0o777, 0o700);
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
      await fs.rm(configHome, { recursive: true, force: true });
    }
  });

  it(
    'repairs loose permissions on a pre-existing config',
    { skip: process.platform === 'win32' },
    async () => {
      const prev = process.env.XDG_CONFIG_HOME;
      const configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-global-config-'));
      process.env.XDG_CONFIG_HOME = configHome;

      try {
        const dir = path.join(configHome, 'factory');
        const file = path.join(dir, 'config.json');
        await fs.mkdir(dir, { recursive: true, mode: 0o755 });
        await fs.writeFile(file, '{"token":"old"}\n', { mode: 0o644 });
        assert.strictEqual((await fs.stat(file)).mode & 0o777, 0o644);

        await saveGlobalConfig({ token: 'new' });

        assert.strictEqual((await fs.stat(file)).mode & 0o777, 0o600);
        assert.strictEqual((await fs.stat(dir)).mode & 0o777, 0o700);
        const cfg = await loadGlobalConfig();
        assert.strictEqual(cfg.token, 'new');
      } finally {
        if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prev;
        await fs.rm(configHome, { recursive: true, force: true });
      }
    },
  );

  it('produces a valid JSON file under concurrent writes', async () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-global-config-'));
    process.env.XDG_CONFIG_HOME = configHome;

    try {
      await Promise.all([
        saveGlobalConfig({ token: 'a' }),
        saveGlobalConfig({ huggingfaceToken: 'b' }),
      ]);
      const cfg = await loadGlobalConfig();
      // One of the writes wins last; either way, the file must be valid JSON
      // (loadGlobalConfig would throw otherwise) and contain at least one of
      // the two values.
      assert.ok(cfg.token === 'a' || cfg.huggingfaceToken === 'b');
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
      await fs.rm(configHome, { recursive: true, force: true });
    }
  });
});

describe('loadProjectConfig - mcp validation', () => {
  it('accepts a well-formed stdio MCP server entry', async () => {
    const content = JSON.stringify({
      mcp: {
        servers: [
          {
            name: 'fs',
            transport: 'stdio',
            command: '/usr/local/bin/mcp-fs',
            args: ['--root', '/tmp'],
            env: { FOO: 'bar' },
          },
        ],
      },
    });
    await withTempProject(content, async cwd => {
      const cfg = await loadProjectConfig(cwd);
      assert.strictEqual(cfg.mcp?.servers?.length, 1);
      assert.strictEqual(cfg.mcp.servers[0].name, 'fs');
    });
  });

  it('rejects an MCP entry that is not a plain object', async () => {
    const content = JSON.stringify({ mcp: { servers: ['not-an-object'] } });
    await withTempProject(content, async cwd => {
      await assert.rejects(loadProjectConfig(cwd), /mcp\.servers\[0\].*must be an object/);
    });
  });

  it('rejects an MCP entry missing a name', async () => {
    const content = JSON.stringify({
      mcp: { servers: [{ transport: 'stdio', command: '/bin/x' }] },
    });
    await withTempProject(content, async cwd => {
      await assert.rejects(loadProjectConfig(cwd), /mcp\.servers\[0\]\.name/);
    });
  });

  it('rejects an MCP entry with an unsupported transport', async () => {
    const content = JSON.stringify({
      mcp: { servers: [{ name: 's', transport: 'websocket', command: '/bin/x' }] },
    });
    await withTempProject(content, async cwd => {
      await assert.rejects(loadProjectConfig(cwd), /mcp\.servers\[0\]\.transport/);
    });
  });

  it('rejects a stdio MCP entry missing a command', async () => {
    const content = JSON.stringify({
      mcp: { servers: [{ name: 's', transport: 'stdio' }] },
    });
    await withTempProject(content, async cwd => {
      await assert.rejects(loadProjectConfig(cwd), /mcp\.servers\[0\]\.command/);
    });
  });

  it('rejects MCP args that are not all strings', async () => {
    const content = JSON.stringify({
      mcp: {
        servers: [{ name: 's', transport: 'stdio', command: '/bin/x', args: ['ok', 123] }],
      },
    });
    await withTempProject(content, async cwd => {
      await assert.rejects(loadProjectConfig(cwd), /mcp\.servers\[0\]\.args/);
    });
  });

  it('rejects MCP env values that are not strings', async () => {
    const content = JSON.stringify({
      mcp: {
        servers: [{ name: 's', transport: 'stdio', command: '/bin/x', env: { K: 1 } }],
      },
    });
    await withTempProject(content, async cwd => {
      await assert.rejects(
        loadProjectConfig(cwd),
        /"mcp\.servers\[0\]\.env\["K"\]" must be a string/,
      );
    });
  });
});
