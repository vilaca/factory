import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { defaultRegistry } from '../../../src/tools/index.js';

// Path-jail enforcement on Read/Write/Edit. tools.test.ts already covers
// the same enforcement on Grep/Glob; this fills the gap for the file tools.
// We use a tmp dir + user-supplied deny entry rather than the built-in
// (~/.ssh) so the test doesn't depend on the host's home layout and can
// safely use unique paths.

const read = defaultRegistry.get('Read')!;
const write = defaultRegistry.get('Write')!;
const edit = defaultRegistry.get('Edit')!;

function denyDir(): { tmp: string; denied: string; secret: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-jail-'));
  const denied = path.join(tmp, 'forbidden');
  fs.mkdirSync(denied);
  const secret = path.join(denied, 'secret.txt');
  fs.writeFileSync(secret, 'classified\n');
  return { tmp, denied, secret };
}

describe('Read — path-jail enforcement', () => {
  it('refuses to read a file under a user-denied root', async () => {
    const { tmp, denied, secret } = denyDir();
    try {
      const result = await read.execute(
        { file_path: secret },
        { cwd: process.cwd(), pathPolicy: { deny: [denied] } },
      );
      assert.strictEqual(result.success, false);
      assert.match(result.output, /denied/);
      assert.ok(!result.output.includes('classified'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to read the denied directory itself (not just files under it)', async () => {
    const { tmp, denied } = denyDir();
    try {
      const result = await read.execute(
        { file_path: denied },
        { cwd: process.cwd(), pathPolicy: { deny: [denied] } },
      );
      assert.strictEqual(result.success, false);
      assert.match(result.output, /denied/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses a path that aliases a denied root via symlink', async () => {
    // Symlink games: the model points Read at a benign-looking name that
    // realpath-resolves into the denied tree. The path-jail must check
    // realpath, not the lexical input.
    const { tmp, denied, secret } = denyDir();
    const link = path.join(os.tmpdir(), `oc-jail-link-${crypto.randomUUID()}`);
    fs.symlinkSync(secret, link);
    try {
      const result = await read.execute(
        { file_path: link },
        { cwd: process.cwd(), pathPolicy: { deny: [denied] } },
      );
      assert.strictEqual(result.success, false);
      assert.match(result.output, /denied/);
    } finally {
      try {
        fs.unlinkSync(link);
      } catch {
        /* ignore */
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Write — path-jail enforcement', () => {
  it('refuses to write a new file under a user-denied root', async () => {
    const { tmp, denied } = denyDir();
    const target = path.join(denied, 'evil.txt');
    try {
      const result = await write.execute(
        { file_path: target, content: 'bad' },
        { cwd: process.cwd(), pathPolicy: { deny: [denied] } },
      );
      assert.strictEqual(result.success, false);
      assert.match(result.output, /denied/);
      assert.ok(!fs.existsSync(target), 'denied write must not create the file');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing file under a user-denied root', async () => {
    const { tmp, denied, secret } = denyDir();
    const before = fs.readFileSync(secret, 'utf-8');
    try {
      const result = await write.execute(
        { file_path: secret, content: 'overwritten' },
        { cwd: process.cwd(), pathPolicy: { deny: [denied] } },
      );
      assert.strictEqual(result.success, false);
      assert.match(result.output, /denied/);
      assert.strictEqual(fs.readFileSync(secret, 'utf-8'), before);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Edit — path-jail enforcement', () => {
  it('refuses to edit a file under a user-denied root', async () => {
    const { tmp, denied, secret } = denyDir();
    const before = fs.readFileSync(secret, 'utf-8');
    try {
      const result = await edit.execute(
        { file_path: secret, old_string: 'classified', new_string: 'leaked' },
        { cwd: process.cwd(), pathPolicy: { deny: [denied] } },
      );
      assert.strictEqual(result.success, false);
      assert.match(result.output, /denied/);
      assert.strictEqual(fs.readFileSync(secret, 'utf-8'), before);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
