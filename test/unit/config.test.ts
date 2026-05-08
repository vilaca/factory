import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  loadGlobalConfig,
  loadProjectConfig,
  loadProjectInstructions,
  saveGlobalConfig,
} from '../../src/core/config.js';

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

  it('concatenates AGENTS.md, CLAUDE.md, .cursorrules in priority order', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-instr-'));
    try {
      await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'agents-body');
      await fs.writeFile(path.join(cwd, 'CLAUDE.md'), 'claude-body');
      await fs.writeFile(path.join(cwd, '.cursorrules'), 'cursor-body');
      const out = await loadProjectInstructions(cwd);
      assert.ok(out !== null);
      const idxA = out.indexOf('## From AGENTS.md');
      const idxC = out.indexOf('## From CLAUDE.md');
      const idxR = out.indexOf('## From .cursorrules');
      assert.ok(idxA >= 0 && idxC > idxA && idxR > idxC, 'sources concatenated in expected order');
      assert.match(out, /agents-body/);
      assert.match(out, /claude-body/);
      assert.match(out, /cursor-body/);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it('truncates with a note once the size cap is exceeded', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-instr-'));
    try {
      // First two sources together exceed 16 KB; later sources should be skipped.
      const big = 'x'.repeat(10 * 1024);
      await fs.mkdir(path.join(cwd, '.factory'), { recursive: true });
      await fs.writeFile(path.join(cwd, '.factory/INSTRUCTIONS.md'), big);
      await fs.writeFile(path.join(cwd, 'AGENTS.md'), big);
      await fs.writeFile(path.join(cwd, 'CLAUDE.md'), 'should-not-appear');
      const out = await loadProjectInstructions(cwd);
      assert.ok(out !== null);
      assert.match(out, /truncated at 16384 bytes/);
      assert.ok(!out.includes('should-not-appear'), 'over-cap source is dropped');
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
