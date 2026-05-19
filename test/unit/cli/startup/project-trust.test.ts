import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { handleProjectTrust } from '../../../../src/cli/startup/phases.js';
import type { Config } from '../../../../src/core/config/types.js';

async function withTempProject(
  configJson: object,
  fn: (cwd: string, trustHome: string) => Promise<void>,
): Promise<void> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-trust-'));
  const trustHome = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = trustHome;
  try {
    const dir = path.join(cwd, '.factory');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(configJson));
    await fn(cwd, trustHome);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(trustHome, { recursive: true, force: true });
  }
}

describe('handleProjectTrust - MCP servers', () => {
  it('strips project MCP servers when the project is untrusted (non-TTY default reject)', async () => {
    const projectCfg = {
      mcp: {
        servers: [
          { name: 'hostile', transport: 'stdio', command: '/bin/sh', args: ['-c', 'pwn'] },
        ],
      },
    };
    await withTempProject(projectCfg, async cwd => {
      // Merged config mirrors what loadConfig produces — project MCP entries
      // are concatenated into config.mcp.servers.
      const merged: Config = {
        mcp: {
          servers: [
            { name: 'hostile', transport: 'stdio', command: '/bin/sh', args: ['-c', 'pwn'] },
          ],
        },
      };
      await handleProjectTrust(merged, cwd);
      assert.deepStrictEqual(merged.mcp?.servers, []);
    });
  });

  it('preserves user-level MCP servers while stripping project ones', async () => {
    const projectCfg = {
      mcp: {
        servers: [
          { name: 'hostile', transport: 'stdio', command: '/bin/sh', args: ['-c', 'pwn'] },
        ],
      },
    };
    await withTempProject(projectCfg, async cwd => {
      const merged: Config = {
        mcp: {
          servers: [
            // user-level server (would come from ~/.config/factory/config.json)
            { name: 'user-fs', transport: 'stdio', command: '/usr/local/bin/mcp-fs' },
            // project-level server (would be appended by mergeConfigs)
            { name: 'hostile', transport: 'stdio', command: '/bin/sh', args: ['-c', 'pwn'] },
          ],
        },
      };
      await handleProjectTrust(merged, cwd);
      assert.strictEqual(merged.mcp?.servers?.length, 1);
      assert.strictEqual(merged.mcp.servers[0].name, 'user-fs');
    });
  });

  it('is a no-op when the project declares neither hooks nor MCP servers', async () => {
    await withTempProject({ provider: 'ollama' }, async cwd => {
      const merged: Config = {
        mcp: { servers: [{ name: 'user-fs', transport: 'stdio', command: '/x' }] },
      };
      await handleProjectTrust(merged, cwd);
      // User-level config untouched.
      assert.strictEqual(merged.mcp?.servers?.length, 1);
    });
  });

  it('skips the prompt and keeps project MCP servers once trust is recorded', async () => {
    const projectCfg = {
      mcp: {
        servers: [{ name: 'trusted', transport: 'stdio', command: '/bin/x' }],
      },
    };
    await withTempProject(projectCfg, async (cwd, trustHome) => {
      // Pre-seed the trust DB with the matching fingerprint.
      const { fingerprintProjectTrustables } = await import(
        '../../../../src/core/hooks/trust.js'
      );
      const fp = fingerprintProjectTrustables({
        hooks: undefined,
        mcpServers: [{ name: 'trusted', transport: 'stdio', command: '/bin/x' }],
      });
      const dbDir = path.join(trustHome, '.factory');
      await fs.mkdir(dbDir, { recursive: true });
      await fs.writeFile(
        path.join(dbDir, 'trusted-projects.json'),
        JSON.stringify({ [cwd]: { fingerprint: fp } }),
      );

      const merged: Config = {
        mcp: { servers: [{ name: 'trusted', transport: 'stdio', command: '/bin/x' }] },
      };
      await handleProjectTrust(merged, cwd);
      assert.strictEqual(merged.mcp?.servers?.length, 1);
      assert.strictEqual(merged.mcp.servers[0].name, 'trusted');
    });
  });
});
