import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { loadProjectConfig, loadGlobalConfig, saveGlobalConfig } from '../../src/core/config.js';

async function withProjectFile(
  content: string,
  fn: (cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-rotcfg-'));
  try {
    const dir = path.join(cwd, '.factory');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'config.json'), content);
    await fn(cwd);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

async function withGlobalHome(fn: (home: string) => Promise<void>): Promise<void> {
  const prev = process.env.XDG_CONFIG_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-rotcfg-glob-'));
  process.env.XDG_CONFIG_HOME = home;
  try {
    await fn(home);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    await fs.rm(home, { recursive: true, force: true });
  }
}

describe('agent.rotation validation', () => {
  it('accepts a fully-typed rotation block', async () => {
    const content = JSON.stringify({
      agent: {
        rotation: {
          keys: true,
          models: false,
          probeAfterTurns: 5,
          default: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
          overrides: {
            'groq:llama-3.3-70b': [
              { provider: 'cerebras', model: 'gpt-oss-120b' },
            ],
          },
        },
      },
    });
    await withProjectFile(content, async (cwd) => {
      const cfg = await loadProjectConfig(cwd);
      assert.strictEqual(cfg.agent?.rotation?.keys, true);
      assert.strictEqual(cfg.agent?.rotation?.models, false);
      assert.strictEqual(cfg.agent?.rotation?.probeAfterTurns, 5);
      assert.strictEqual(cfg.agent?.rotation?.default?.length, 1);
      assert.strictEqual(cfg.agent?.rotation?.overrides?.['groq:llama-3.3-70b']?.[0]?.provider, 'cerebras');
    });
  });

  it('rejects non-boolean keys flag', async () => {
    const content = JSON.stringify({ agent: { rotation: { keys: 'yes' } } });
    await withProjectFile(content, async (cwd) => {
      await assert.rejects(
        loadProjectConfig(cwd),
        /"agent\.rotation\.keys" must be a boolean/,
      );
    });
  });

  it('rejects negative probeAfterTurns', async () => {
    const content = JSON.stringify({ agent: { rotation: { probeAfterTurns: -1 } } });
    await withProjectFile(content, async (cwd) => {
      await assert.rejects(
        loadProjectConfig(cwd),
        /"agent\.rotation\.probeAfterTurns" must be a non-negative integer/,
      );
    });
  });

  it('rejects non-array default chain', async () => {
    const content = JSON.stringify({ agent: { rotation: { default: 'nope' } } });
    await withProjectFile(content, async (cwd) => {
      await assert.rejects(
        loadProjectConfig(cwd),
        /"agent\.rotation\.default" must be an array/,
      );
    });
  });

  it('rejects entry with empty provider', async () => {
    const content = JSON.stringify({
      agent: { rotation: { default: [{ provider: '', model: 'x' }] } },
    });
    await withProjectFile(content, async (cwd) => {
      await assert.rejects(
        loadProjectConfig(cwd),
        /"agent\.rotation\.default\[0\]\.provider" must be a non-empty string/,
      );
    });
  });

  it('rejects override with malformed entry', async () => {
    const content = JSON.stringify({
      agent: {
        rotation: {
          overrides: { 'a:b': [{ provider: 'c', model: 42 }] },
        },
      },
    });
    await withProjectFile(content, async (cwd) => {
      await assert.rejects(
        loadProjectConfig(cwd),
        /"agent\.rotation\.overrides\..*\[0\]\.model" must be a non-empty string/,
      );
    });
  });
});

describe('saveGlobalConfig with rotation', () => {
  it('round-trips a rotation block through global config', async () => {
    await withGlobalHome(async () => {
      await saveGlobalConfig({
        agent: {
          rotation: {
            default: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
          },
        },
      });
      const cfg = await loadGlobalConfig();
      assert.strictEqual(cfg.agent?.rotation?.default?.length, 1);
      assert.strictEqual(cfg.agent?.rotation?.default?.[0]?.model, 'claude-haiku-4-5');
    });
  });
});
