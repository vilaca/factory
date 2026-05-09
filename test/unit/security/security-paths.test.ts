import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { checkPath, assertPathAllowed, PathDenied } from '../../../src/security/paths.js';

describe('checkPath: built-in deny list', () => {
  const home = os.homedir();

  it('denies ~/.ssh and files under it (even non-existent)', async () => {
    const r = await checkPath(path.join(home, '.ssh', 'id_rsa'));
    assert.strictEqual(r.ok, false);
    assert.match(r.matchedRule!, /\.ssh$/);
  });

  it('denies the ~/.ssh directory itself', async () => {
    const r = await checkPath(path.join(home, '.ssh'));
    assert.strictEqual(r.ok, false);
  });

  it('denies ~/.aws/credentials', async () => {
    const r = await checkPath(path.join(home, '.aws', 'credentials'));
    assert.strictEqual(r.ok, false);
    assert.match(r.matchedRule!, /\.aws$/);
  });

  it('denies ~/.netrc', async () => {
    const r = await checkPath(path.join(home, '.netrc'));
    assert.strictEqual(r.ok, false);
  });

  it('denies ~/.docker/config.json', async () => {
    const r = await checkPath(path.join(home, '.docker', 'config.json'));
    assert.strictEqual(r.ok, false);
  });

  it('denies /etc/shadow', async () => {
    const r = await checkPath('/etc/shadow');
    assert.strictEqual(r.ok, false);
  });

  it('does NOT deny ordinary project paths', async () => {
    const cwd = process.cwd();
    const r = await checkPath(path.join(cwd, 'package.json'));
    assert.strictEqual(r.ok, true);
  });

  it('does NOT deny ~/Documents', async () => {
    const r = await checkPath(path.join(home, 'Documents', 'foo.txt'));
    assert.strictEqual(r.ok, true);
  });
});

describe('checkPath: user-extended deny', () => {
  it('honors user-supplied additional deny entries', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-paths-'));
    try {
      const target = path.join(tmp, 'secret-thing');
      const r = await checkPath(target, { deny: [tmp] });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.matchedRule, tmp);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('expands a leading ~ in user deny entries', async () => {
    const r = await checkPath(path.join(os.homedir(), 'custom-secrets', 'token'), {
      deny: ['~/custom-secrets'],
    });
    assert.strictEqual(r.ok, false);
  });
});

describe('checkPath: symlink resolution', () => {
  let tmp: string;
  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-paths-sym-'));
  });
  after(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  it('follows a symlink that points into a denied dir', async () => {
    // Create ~/.ssh-style situation via a denied custom root.
    const denied = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-deny-'));
    try {
      await fs.writeFile(path.join(denied, 'secret'), 'hunter2');
      const link = path.join(tmp, 'looks-safe');
      await fs.symlink(path.join(denied, 'secret'), link);

      const r = await checkPath(link, { deny: [denied] });
      assert.strictEqual(r.ok, false, 'symlink to denied target must be caught');
    } finally {
      await fs.rm(denied, { recursive: true, force: true });
    }
  });
});

describe('assertPathAllowed', () => {
  it('throws PathDenied with attemptedPath + matchedRule on deny', async () => {
    let caught: unknown = null;
    try {
      await assertPathAllowed(path.join(os.homedir(), '.ssh', 'id_rsa'));
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof PathDenied);
    const err = caught as PathDenied;
    assert.match(err.attemptedPath, /\.ssh\/id_rsa$/);
    assert.match(err.message, /Path denied by security policy/);
  });

  it('returns the resolved path on allow', async () => {
    const cwd = process.cwd();
    const target = path.join(cwd, 'package.json');
    const resolved = await assertPathAllowed(target);
    assert.strictEqual(typeof resolved, 'string');
    assert.match(resolved, /package\.json$/);
  });
});
