import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { defaultRegistry } from '../../../src/tools/index.js';
import { cleanup, tmpFile } from './tools-helpers.js';

// ─── Glob tool ──────────────────────────────────────────────────────────

describe('Glob tool', () => {
  const glob = defaultRegistry.get('Glob')!;

  it('finds files matching pattern', async () => {
    const result = await glob.execute({ pattern: 'package.json', path: process.cwd() });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('package.json'));
  });

  it('returns no match message for unmatched pattern', async () => {
    const result = await glob.execute({
      pattern: '*.nonexistent_extension_xyz',
      path: os.tmpdir(),
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('No files matched'));
  });

  it('fails for missing pattern', async () => {
    const result = await glob.execute({});
    assert.strictEqual(result.success, false);
    assert.ok(result.output.includes('required'));
  });
});

// ─── Grep tool ──────────────────────────────────────────────────────────

describe('Grep tool', () => {
  const grep = defaultRegistry.get('Grep')!;

  it('finds pattern in file', async () => {
    const fp = tmpFile('grep', 'findme in this file\nnothing here\n');
    try {
      const result = await grep.execute({ pattern: 'findme', path: fp });
      assert.strictEqual(result.success, true);
      // Should find the file or content
      assert.ok(result.output.includes(fp) || result.output.includes('findme'));
    } finally {
      cleanup(fp);
    }
  });

  it('reports no matches', async () => {
    const fp = tmpFile('grep-nomatch', 'nothing relevant\n');
    try {
      const result = await grep.execute({ pattern: 'xyz_not_present', path: fp });
      assert.strictEqual(result.success, true);
      assert.ok(result.output.includes('No matches'));
    } finally {
      cleanup(fp);
    }
  });

  it('fails for missing pattern', async () => {
    const result = await grep.execute({});
    assert.strictEqual(result.success, false);
    assert.ok(result.output.includes('required'));
  });

  it('caps result lines and emits a truncation footer', async () => {
    // Produce more matches than MAX_RESULT_LINES (1000) by writing a single
    // file with many matching lines. Grep with include_content returns one
    // line per match, so the cap kicks in on output line count.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-grep-cap-'));
    const fp = path.join(tmp, 'big.txt');
    const lines = Array.from({ length: 1500 }, (_, i) => `match-${i}: hit-marker-zzz`);
    fs.writeFileSync(fp, lines.join('\n') + '\n');
    try {
      const result = await grep.execute({
        pattern: 'hit-marker-zzz',
        path: tmp,
        include_content: true,
      });
      assert.strictEqual(result.success, true);
      const outLines = result.output.split('\n');
      // Footer line + cap of 1000 = 1001 lines total.
      assert.strictEqual(outLines.length, 1001, `expected 1001 lines, got ${outLines.length}`);
      assert.ok(
        result.output.includes('truncated'),
        `expected truncation footer in: ${result.output.slice(-200)}`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('handles match volumes that would have blown a 10 MiB buffer', async () => {
    // Regression: previous impl used execFile with maxBuffer=10MiB, so a
    // search at the repo root hitting compiled output / coverage HTML
    // produced enough stdout to exit with "stdout maxBuffer length
    // exceeded" before our line cap could fire. The streaming impl kills
    // rg/grep at MAX_RESULT_LINES + slack, so even ~50 MiB of latent
    // matches return cleanly truncated.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-grep-flood-'));
    try {
      // Each line ~5 KiB. 12_000 lines ≈ 60 MiB if buffered whole — well
      // beyond the old 10 MiB cap. Streaming should kill at ~1050 lines.
      const padding = 'x'.repeat(5000);
      const fp = path.join(tmp, 'huge.txt');
      const lines = Array.from(
        { length: 12_000 },
        (_, i) => `match-${i}: hit-marker-flood-${padding}`,
      );
      fs.writeFileSync(fp, lines.join('\n') + '\n');
      const result = await grep.execute({
        pattern: 'hit-marker-flood',
        path: tmp,
        include_content: true,
      });
      assert.strictEqual(
        result.success,
        true,
        `expected success, got: ${result.output.slice(0, 200)}`,
      );
      const outLines = result.output.split('\n');
      assert.strictEqual(outLines.length, 1001, `expected 1001 lines, got ${outLines.length}`);
      assert.ok(result.output.includes('truncated'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('accepts include_content as boolean true', async () => {
    const fp = tmpFile('grep-bool-true', 'findme in this file\nnothing here\n');
    try {
      const result = await grep.execute({ pattern: 'findme', path: fp, include_content: true });
      assert.strictEqual(result.success, true);
      // Should include line numbers when include_content is true
      assert.ok(result.output.includes('findme in this file'));
      assert.ok(result.output.includes('1:'));
    } finally {
      cleanup(fp);
    }
  });

  it('accepts include_content as boolean false', async () => {
    const fp = tmpFile('grep-bool-false', 'findme in this file\nnothing here\n');
    try {
      const result = await grep.execute({ pattern: 'findme', path: fp, include_content: false });
      assert.strictEqual(result.success, true);
      // Should only show file path when include_content is false
      assert.ok(result.output.includes(fp));
      assert.ok(!result.output.includes('1:'));
    } finally {
      cleanup(fp);
    }
  });

  it('accepts include_content as string "true"', async () => {
    const fp = tmpFile('grep-string-true', 'findme in this file\nnothing here\n');
    try {
      const result = await grep.execute({ pattern: 'findme', path: fp, include_content: 'true' });
      assert.strictEqual(result.success, true);
      // Should include line numbers when include_content is "true"
      assert.ok(result.output.includes('findme in this file'));
      assert.ok(result.output.includes('1:'));
    } finally {
      cleanup(fp);
    }
  });

  it('accepts include_content as string "false"', async () => {
    const fp = tmpFile('grep-string-false', 'findme in this file\nnothing here\n');
    try {
      const result = await grep.execute({ pattern: 'findme', path: fp, include_content: 'false' });
      assert.strictEqual(result.success, true);
      // Should only show file path when include_content is "false"
      assert.ok(result.output.includes(fp));
      assert.ok(!result.output.includes('1:'));
    } finally {
      cleanup(fp);
    }
  });

  it('treats case-insensitive string values correctly', async () => {
    const fp = tmpFile('grep-case', 'findme in this file\nnothing here\n');
    try {
      // Test "True" (capital T)
      const result1 = await grep.execute({ pattern: 'findme', path: fp, include_content: 'True' });
      assert.strictEqual(result1.success, true);
      assert.ok(result1.output.includes('1:'));
      
      // Test "TRUE" (all caps)
      const result2 = await grep.execute({ pattern: 'findme', path: fp, include_content: 'TRUE' });
      assert.strictEqual(result2.success, true);
      assert.ok(result2.output.includes('1:'));
      
      // Test "False" (capital F)
      const result3 = await grep.execute({ pattern: 'findme', path: fp, include_content: 'False' });
      assert.strictEqual(result3.success, true);
      assert.ok(result3.output.includes(fp));
      assert.ok(!result3.output.includes('1:'));
      
      // Test "FALSE" (all caps)
      const result4 = await grep.execute({ pattern: 'findme', path: fp, include_content: 'FALSE' });
      assert.strictEqual(result4.success, true);
      assert.ok(result4.output.includes(fp));
      assert.ok(!result4.output.includes('1:'));
    } finally {
      cleanup(fp);
    }
  });
});

// ─── Search tools deny-list ─────────────────────────────────────────────
// Grep/Glob now share the path-policy enforcement Read/Write/Edit had: an
// explicit search rooted at a denied path fails clean, and recursion from a
// wider root post-filters denied results. We use a tmp dir + user-deny
// entry rather than the real ~/.ssh so tests don't depend on the host's
// home directory.

describe('Search tools: deny-list enforcement', () => {
  const grep = defaultRegistry.get('Grep')!;
  const glob = defaultRegistry.get('Glob')!;

  it('Grep refuses an explicit search path on the deny list', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-deny-'));
    const denied = path.join(tmp, 'forbidden');
    fs.mkdirSync(denied);
    fs.writeFileSync(path.join(denied, 'a.txt'), 'secret-token\n');
    try {
      const result = await grep.execute(
        { pattern: 'secret-token', path: denied },
        { cwd: process.cwd(), pathPolicy: { deny: [denied] } },
      );
      assert.strictEqual(result.success, false);
      assert.ok(result.output.includes('denied'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('Grep filters denied paths out of recursive results from a wider root', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-deny-'));
    const denied = path.join(tmp, 'forbidden');
    fs.mkdirSync(denied);
    fs.writeFileSync(path.join(denied, 'leak.txt'), 'unique-marker-abc123\n');
    fs.writeFileSync(path.join(tmp, 'ok.txt'), 'unique-marker-abc123\n');
    try {
      const result = await grep.execute(
        { pattern: 'unique-marker-abc123', path: tmp },
        { cwd: process.cwd(), pathPolicy: { deny: [denied] } },
      );
      assert.strictEqual(result.success, true);
      assert.ok(result.output.includes('ok.txt'), `expected ok.txt in: ${result.output}`);
      assert.ok(!result.output.includes('leak.txt'), `leaked denied path in: ${result.output}`);
      assert.ok(
        result.output.includes('suppressed'),
        `expected suppression note in: ${result.output}`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('Glob refuses an explicit search path on the deny list', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-deny-'));
    const denied = path.join(tmp, 'forbidden');
    fs.mkdirSync(denied);
    fs.writeFileSync(path.join(denied, 'a.txt'), '');
    try {
      const result = await glob.execute(
        { pattern: '*.txt', path: denied },
        { cwd: process.cwd(), pathPolicy: { deny: [denied] } },
      );
      assert.strictEqual(result.success, false);
      assert.ok(result.output.includes('denied'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('Glob filters denied paths out of recursive results from a wider root', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-deny-'));
    const denied = path.join(tmp, 'forbidden');
    fs.mkdirSync(denied);
    fs.writeFileSync(path.join(denied, 'leak.txt'), '');
    fs.writeFileSync(path.join(tmp, 'ok.txt'), '');
    try {
      const result = await glob.execute(
        { pattern: '**/*.txt', path: tmp },
        { cwd: process.cwd(), pathPolicy: { deny: [denied] } },
      );
      assert.strictEqual(result.success, true);
      assert.ok(result.output.includes('ok.txt'), `expected ok.txt in: ${result.output}`);
      assert.ok(!result.output.includes('leak.txt'), `leaked denied path in: ${result.output}`);
      assert.ok(
        result.output.includes('suppressed'),
        `expected suppression note in: ${result.output}`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
