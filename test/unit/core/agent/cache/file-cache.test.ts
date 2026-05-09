import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { FileCache } from '../../../../../src/core/agent/cache/file-cache.js';

async function tempFile(content: string): Promise<string> {
  const fp = path.join(os.tmpdir(), `oc-fc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.writeFile(fp, content);
  return fp;
}

describe('FileCache', () => {
  it('stamps a file with mtime, size, and sha256', async () => {
    const fp = await tempFile('hello\n');
    try {
      const stamp = await FileCache.stamp(fp);
      assert.ok(stamp);
      assert.strictEqual(stamp!.size, 6);
      assert.match(stamp!.hash, /^[a-f0-9]{64}$/);
    } finally {
      await fs.unlink(fp);
    }
  });

  it('returns undefined for missing files', async () => {
    const stamp = await FileCache.stamp('/this/path/does/not/exist');
    assert.strictEqual(stamp, undefined);
  });

  it('records and retrieves an entry', async () => {
    const fp = await tempFile('content');
    try {
      const cache = new FileCache();
      const stamp = await FileCache.stamp(fp);
      cache.record(fp, stamp!);
      const got = cache.get(fp);
      assert.ok(got);
      assert.strictEqual(got!.path, fp);
      assert.strictEqual(got!.hash, stamp!.hash);
    } finally {
      await fs.unlink(fp);
    }
  });

  it('invalidate() drops the entry', async () => {
    const fp = await tempFile('content');
    try {
      const cache = new FileCache();
      const stamp = await FileCache.stamp(fp);
      cache.record(fp, stamp!);
      cache.invalidate(fp);
      assert.strictEqual(cache.get(fp), undefined);
    } finally {
      await fs.unlink(fp);
    }
  });

  it('wasReadBeforeCompaction is true only after a noteCompaction call', async () => {
    const fp = await tempFile('content');
    try {
      const cache = new FileCache();
      const stamp = await FileCache.stamp(fp);
      cache.record(fp, stamp!);
      assert.strictEqual(cache.wasReadBeforeCompaction(fp), false);
      cache.noteCompaction();
      assert.strictEqual(cache.wasReadBeforeCompaction(fp), true);
    } finally {
      await fs.unlink(fp);
    }
  });

  it('a record AFTER compaction is not flagged as pre-compaction', async () => {
    const fp = await tempFile('content');
    try {
      const cache = new FileCache();
      cache.noteCompaction();
      const stamp = await FileCache.stamp(fp);
      cache.record(fp, stamp!);
      assert.strictEqual(cache.wasReadBeforeCompaction(fp), false);
    } finally {
      await fs.unlink(fp);
    }
  });

  it('fingerprints() returns sorted (path, hash) pairs', async () => {
    const a = await tempFile('a');
    const b = await tempFile('b');
    try {
      const cache = new FileCache();
      cache.record(b, (await FileCache.stamp(b))!);
      cache.record(a, (await FileCache.stamp(a))!);
      const fps = cache.fingerprints();
      assert.strictEqual(fps.length, 2);
      assert.ok(fps[0].path.localeCompare(fps[1].path) < 0, 'should be sorted');
    } finally {
      await fs.unlink(a);
      await fs.unlink(b);
    }
  });

  it('detects content change via hash mismatch', async () => {
    const fp = await tempFile('original');
    try {
      const stamp1 = await FileCache.stamp(fp);
      // Wait a bit so mtime changes detectably on filesystems with second-level resolution.
      await new Promise(r => setTimeout(r, 10));
      await fs.writeFile(fp, 'modified');
      const stamp2 = await FileCache.stamp(fp);
      assert.notStrictEqual(stamp1!.hash, stamp2!.hash);
    } finally {
      await fs.unlink(fp);
    }
  });
});
