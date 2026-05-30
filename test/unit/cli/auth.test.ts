import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  resolveCredentialsFor,
  probeModels,
  probeAllProviders,
  ensureAuth,
  saveCredentialsAfterModelDiscovery,
  type AuthResult,
} from '../../../src/cli/auth/index.js';
import { DESCRIPTORS } from '../../../src/providers/registry.js';
import type { Config } from '../../../src/core/config/types.js';
import { saveGlobalConfig } from '../../../src/core/config/index.js';

let originalHome: string | undefined;
let originalLog: typeof console.log;

before(() => {
  originalHome = process.env.HOME;
  originalLog = console.log;
  // Suppress chalk output from auth flows we run in-process. Restored in after().
  console.log = () => {};
});

const originalXdg = process.env.XDG_CONFIG_HOME;

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  console.log = originalLog;
});

let configDir: string;

beforeEach(() => {
  const home = path.join(os.tmpdir(), `oc-auth-${crypto.randomUUID()}`);
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  // saveGlobalConfig writes to $XDG_CONFIG_HOME/factory/config.json — point
  // it inside the per-test home so writes don't leak into the user's real
  // ~/.config/factory.
  configDir = path.join(home, '.config');
  process.env.XDG_CONFIG_HOME = configDir;
  // Wipe env vars that could leak across tests.
  for (const v of [
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'GITHUB_COPILOT_API_KEY',
    'COPILOT_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
  ]) {
    delete process.env[v];
  }
});

describe('resolveCredentialsFor — simple-prompt providers', () => {
  it('prefers --token over config and env', () => {
    const config: Config = { anthropicToken: 'config-token' };
    process.env.ANTHROPIC_API_KEY = 'env-token';
    const creds = resolveCredentialsFor(DESCRIPTORS.anthropic, config, 'cli-token');
    assert.strictEqual(creds.token, 'cli-token');
    assert.strictEqual(creds.keyId, undefined);
  });

  it('reads from the multi-key store when available', () => {
    const config: Config = {
      keys: {
        anthropic: [{ id: 'k1', token: 'stored-token', createdAt: '2026-01-01T00:00:00Z' }],
      },
    };
    const creds = resolveCredentialsFor(DESCRIPTORS.anthropic, config);
    assert.strictEqual(creds.token, 'stored-token');
    assert.strictEqual(creds.keyId, 'k1');
  });

  it('falls back to env when no key is stored and no cliToken is given', () => {
    process.env.ANTHROPIC_API_KEY = 'env-token';
    const creds = resolveCredentialsFor(DESCRIPTORS.anthropic, {});
    assert.strictEqual(creds.token, 'env-token');
    assert.strictEqual(creds.keyId, undefined);
  });

  it('returns no token when nothing is configured', () => {
    const creds = resolveCredentialsFor(DESCRIPTORS.anthropic, {});
    assert.strictEqual(creds.token, undefined);
  });

  it('selects a specific keyId from the store when provided', () => {
    const config: Config = {
      keys: {
        anthropic: [
          { id: 'k1', token: 'tok-1', createdAt: '2026-01-01T00:00:00Z' },
          { id: 'k2', token: 'tok-2', createdAt: '2026-02-01T00:00:00Z' },
        ],
      },
    };
    const creds = resolveCredentialsFor(DESCRIPTORS.anthropic, config, undefined, 'k2');
    assert.strictEqual(creds.token, 'tok-2');
    assert.strictEqual(creds.keyId, 'k2');
  });
});

describe('resolveCredentialsFor — copilot', () => {
  it('prefers --token, then config.copilotToken, then env, then githubToken', () => {
    const cfg: Config = { copilotToken: 'cfg-tok', githubToken: 'gh-tok' };
    process.env.GITHUB_COPILOT_API_KEY = 'env-tok';

    // CLI wins.
    let creds = resolveCredentialsFor(DESCRIPTORS.copilot, cfg, 'cli');
    assert.strictEqual(creds.token, 'cli');
    assert.strictEqual(creds.githubToken, 'gh-tok');

    // No CLI → config wins over env.
    creds = resolveCredentialsFor(DESCRIPTORS.copilot, cfg);
    assert.strictEqual(creds.token, 'cfg-tok');

    // No CLI, no config → env wins.
    delete cfg.copilotToken;
    creds = resolveCredentialsFor(DESCRIPTORS.copilot, cfg);
    assert.strictEqual(creds.token, 'env-tok');
  });

  it('falls back to githubToken-only when no copilot token is anywhere', () => {
    const creds = resolveCredentialsFor(DESCRIPTORS.copilot, { githubToken: 'gh-only' });
    assert.strictEqual(creds.token, undefined);
    assert.strictEqual(creds.githubToken, 'gh-only');
  });
});

describe('resolveCredentialsFor — googleaistudio', () => {
  it('returns api-key mode when --token is passed', () => {
    const creds = resolveCredentialsFor(DESCRIPTORS.googleaistudio, {}, 'cli-key');
    assert.strictEqual(creds.authMode, 'api-key');
    assert.strictEqual(creds.token, 'cli-key');
  });

  it('returns oauth mode when configured', () => {
    const creds = resolveCredentialsFor(DESCRIPTORS.googleaistudio, {
      googleAiStudioAuthMode: 'oauth',
    });
    assert.strictEqual(creds.authMode, 'oauth');
    assert.strictEqual(creds.token, undefined);
  });

  it('returns api-key mode when GEMINI_API_KEY env var is set', () => {
    process.env.GEMINI_API_KEY = 'env-gemini';
    const creds = resolveCredentialsFor(DESCRIPTORS.googleaistudio, {});
    assert.strictEqual(creds.authMode, 'api-key');
    assert.strictEqual(creds.token, 'env-gemini');
  });

  it('returns api-key mode when GOOGLE_API_KEY env var is set', () => {
    process.env.GOOGLE_API_KEY = 'env-google';
    const creds = resolveCredentialsFor(DESCRIPTORS.googleaistudio, {});
    assert.strictEqual(creds.authMode, 'api-key');
    assert.strictEqual(creds.token, 'env-google');
  });

  it('returns no authMode when nothing is configured', () => {
    const creds = resolveCredentialsFor(DESCRIPTORS.googleaistudio, {});
    assert.strictEqual(creds.authMode, undefined);
  });
});

describe('probeModels', () => {
  it('returns null when the provider throws (e.g. unreachable host)', async () => {
    const result = await probeModels('ollama', { host: 'http://127.0.0.1:1' });
    assert.strictEqual(result, null);
  });

  it('returns the listModels result on success', async () => {
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'a' }, { name: 'b' }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    try {
      const result = await probeModels('ollama', { host: `http://127.0.0.1:${addr.port}` });
      assert.deepStrictEqual(result, ['a', 'b']);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe('probeAllProviders', () => {
  it('skips providers that lack credentials and probes the rest', async () => {
    const config: Config = { host: 'http://127.0.0.1:1' };
    // No creds for any provider.
    const result = await probeAllProviders(config, new Map());

    // Probed-without-credentials providers (e.g. ollama) attempt the probe.
    // Those that need creds (e.g. anthropic, openrouter) should be skipped → null.
    assert.strictEqual(result.get('anthropic'), null);
    assert.strictEqual(result.get('openrouter'), null);
    // Ollama probes regardless; the unreachable host will produce null too.
    assert.ok(result.has('ollama'));
  });

  it('skips providers with probeAtStartup=false (e.g. copilot)', async () => {
    const result = await probeAllProviders({ host: 'http://127.0.0.1:1' }, new Map());
    assert.ok(!result.has('copilot'), 'copilot should not be probed at startup');
  });
});

describe('ensureAuth — non-interactive paths', () => {
  it("returns no-op for descriptors with authFlow='none'", async () => {
    // Ollama is authFlow='none'.
    const result = await ensureAuth(DESCRIPTORS.ollama, {});
    assert.deepStrictEqual(result, { shouldSave: false });
  });

  it('returns existing token without prompting for simple-prompt providers', async () => {
    const config: Config = {
      keys: {
        anthropic: [{ id: 'k1', token: 'pre-saved', createdAt: '2026-01-01T00:00:00Z' }],
      },
    };
    const result = await ensureAuth(DESCRIPTORS.anthropic, config);
    assert.strictEqual(result.token, 'pre-saved');
    assert.strictEqual(result.keyId, 'k1');
    assert.strictEqual(result.shouldSave, false);
  });

  it('re-reads global config when a requested keyId is missing from a stale snapshot', async () => {
    await saveGlobalConfig({
      keys: {
        anthropic: [{ id: 'new-key', token: 'fresh-token', createdAt: '2026-01-01T00:00:00Z' }],
      },
    });
    const staleConfig: Config = {};
    const result = await ensureAuth(DESCRIPTORS.anthropic, staleConfig, undefined, 'new-key');
    assert.strictEqual(result.token, 'fresh-token');
    assert.strictEqual(result.keyId, 'new-key');
    assert.strictEqual(result.shouldSave, false);
  });

  it('returns existing copilot token without device flow when one is configured', async () => {
    const result = await ensureAuth(DESCRIPTORS.copilot, { copilotToken: 'pre-saved-copilot' });
    assert.strictEqual(result.token, 'pre-saved-copilot');
    assert.strictEqual(result.shouldSave, false);
  });

  it('returns saved githubToken when no copilot token but githubToken exists', async () => {
    const result = await ensureAuth(DESCRIPTORS.copilot, { githubToken: 'gh-token' });
    assert.strictEqual(result.githubToken, 'gh-token');
    assert.strictEqual(result.token, undefined);
    assert.strictEqual(result.shouldSave, false);
  });

  it('returns api-key without prompting when a Google AI Studio API key is configured', async () => {
    const result = await ensureAuth(DESCRIPTORS.googleaistudio, {
      googleAiStudioToken: 'gemini-key',
    });
    assert.strictEqual(result.token, 'gemini-key');
    assert.strictEqual(result.authMode, 'api-key');
    assert.strictEqual(result.shouldSave, false);
  });
});

describe('saveCredentialsAfterModelDiscovery', () => {
  it('returns undefined and does nothing when shouldSave is false', async () => {
    const result = await saveCredentialsAfterModelDiscovery(
      DESCRIPTORS.anthropic,
      { token: 'x', shouldSave: false } as AuthResult,
      true,
    );
    assert.strictEqual(result, undefined);
    // No config was written for this provider's keys.
    const cfgPath = path.join(configDir, 'factory', 'config.json');
    if (fs.existsSync(cfgPath)) {
      const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      assert.ok(
        !(saved.keys?.anthropic?.length > 0),
        'no key should be saved when shouldSave=false',
      );
    }
  });

  it('returns undefined when no models were discovered (skips save)', async () => {
    const result = await saveCredentialsAfterModelDiscovery(
      DESCRIPTORS.anthropic,
      { token: 'x', shouldSave: true } as AuthResult,
      false,
    );
    assert.strictEqual(result, undefined);
  });

  it('saves a simple-prompt token to the multi-key store and returns the new keyId', async () => {
    const auth: AuthResult = { token: 'sk-test-anthropic', shouldSave: true };
    const result = await saveCredentialsAfterModelDiscovery(DESCRIPTORS.anthropic, auth, true);
    assert.ok(result, 'expected a saved key id');

    const cfgPath = path.join(configDir, 'factory', 'config.json');
    const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const keys = saved.keys?.anthropic ?? [];
    assert.strictEqual(keys.length, 1);
    assert.strictEqual(keys[0].token, 'sk-test-anthropic');
    assert.strictEqual(keys[0].id, result);
  });

  it('persists a non-simple-prompt token on the legacy field (e.g. googleaistudio api-key)', async () => {
    const auth: AuthResult = {
      token: 'gemini-test-key',
      authMode: 'api-key',
      shouldSave: true,
    };
    await saveCredentialsAfterModelDiscovery(DESCRIPTORS.googleaistudio, auth, true);
    const cfgPath = path.join(configDir, 'factory', 'config.json');
    const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    assert.strictEqual(saved.googleAiStudioToken, 'gemini-test-key');
    assert.strictEqual(saved.googleAiStudioAuthMode, 'api-key');
  });
});
