import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { readFileForCorrector } from '../../../../src/core/agent/tool-calls/run-tool-calls.js';

const READ_CAP = 32 * 1024;

async function tempFile(size: number): Promise<string> {
  const fp = path.join(os.tmpdir(), `oc-cap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  // Repeating ASCII "a" so byte count == char count.
  await fs.writeFile(fp, 'a'.repeat(size));
  return fp;
}

describe('readFileForCorrector', () => {
  it('returns full content for a file under the cap', async () => {
    const fp = await tempFile(1024);
    try {
      const result = await readFileForCorrector({
        function: { name: 'Edit', arguments: { file_path: fp } },
      });
      assert.ok(result);
      assert.strictEqual(result!.content.length, 1024);
    } finally {
      await fs.unlink(fp);
    }
  });

  it('truncates content to the cap for a large file', async () => {
    const fp = await tempFile(READ_CAP * 4);
    try {
      const result = await readFileForCorrector({
        function: { name: 'Edit', arguments: { file_path: fp } },
      });
      assert.ok(result);
      assert.strictEqual(result!.content.length, READ_CAP, 'content should be capped');
      assert.strictEqual(result!.path, fp);
    } finally {
      await fs.unlink(fp);
    }
  });

  it('returns undefined for missing files', async () => {
    const result = await readFileForCorrector({
      function: { name: 'Edit', arguments: { file_path: '/definitely-not-a-real-path-xyz' } },
    });
    assert.strictEqual(result, undefined);
  });

  it('returns undefined when file_path is missing or non-string', async () => {
    const a = await readFileForCorrector({ function: { name: 'Edit', arguments: {} } });
    assert.strictEqual(a, undefined);
    const b = await readFileForCorrector({
      function: { name: 'Edit', arguments: { file_path: 42 as unknown as string } },
    });
    assert.strictEqual(b, undefined);
  });
});
