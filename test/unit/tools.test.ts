import { describe, it } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { getTool } from '../../src/tools/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function tmpFile(prefix: string, content?: string): string {
  const filePath = path.join(os.tmpdir(), `oc-unit-${prefix}-${crypto.randomUUID()}.txt`);
  if (content !== undefined) {
    fs.writeFileSync(filePath, content);
  }
  return filePath;
}

function cleanup(filePath: string): void {
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}

// ─── Read tool ──────────────────────────────────────────────────────────

describe('Read tool', () => {
  const read = getTool('Read')!;

  it('reads file content with line numbers', async () => {
    const fp = tmpFile('read', 'line1\nline2\nline3\n');
    try {
      const result = await read.execute({ file_path: fp });
      assert.strictEqual(result.success, true);
      assert.ok(result.output.includes('line1'));
      assert.ok(result.output.includes('line2'));
      assert.ok(result.output.includes('line3'));
      // Line numbers should be present
      assert.ok(result.output.includes('1\t'));
    } finally {
      cleanup(fp);
    }
  });

  it('supports offset and limit', async () => {
    const fp = tmpFile('read-offset', 'a\nb\nc\nd\ne\n');
    try {
      const result = await read.execute({ file_path: fp, offset: 1, limit: 2 });
      assert.strictEqual(result.success, true);
      assert.ok(result.output.includes('b'));
      assert.ok(result.output.includes('c'));
      assert.ok(!result.output.includes('\t' + 'a'));
    } finally {
      cleanup(fp);
    }
  });

  it('fails for missing file_path', async () => {
    const result = await read.execute({});
    assert.strictEqual(result.success, false);
    assert.ok(result.output.includes('required'));
  });

  it('fails for non-existent file', async () => {
    const result = await read.execute({ file_path: '/nonexistent/file.txt' });
    assert.strictEqual(result.success, false);
    assert.ok(result.output.includes('Error'));
  });

  it('returns full content to model and truncated displayOutput for long files', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line${i + 1}`);
    const fp = tmpFile('read-long', lines.join('\n'));
    try {
      const result = await read.execute({ file_path: fp });
      assert.strictEqual(result.success, true);
      // Full content goes to model.
      assert.ok(result.output.includes('line1'));
      assert.ok(result.output.includes('line200'));
      assert.ok(!result.output.includes('full content sent to model'));
      // Terminal preview is short and tells the user the rest went to the model.
      assert.ok(result.displayOutput);
      assert.ok(result.displayOutput!.includes('full content sent to model'));
      assert.ok(!result.displayOutput!.includes('line200'));
    } finally {
      cleanup(fp);
    }
  });

  it('uses the chat-friendly "│" separator in displayOutput', async () => {
    const fp = tmpFile('read-short', 'alpha\nbeta\ngamma\n');
    try {
      const result = await read.execute({ file_path: fp });
      assert.strictEqual(result.success, true);
      assert.ok(result.displayOutput);
      // Each line in the preview uses `<num> │ <text>`.
      assert.match(result.displayOutput!, /1 │ alpha/);
      // No "+N" footer when everything fits.
      assert.ok(!result.displayOutput!.includes('full content sent to model'));
    } finally {
      cleanup(fp);
    }
  });
});

// ─── Write tool ─────────────────────────────────────────────────────────

describe('Write tool', () => {
  const write = getTool('Write')!;

  it('creates a new file', async () => {
    const fp = tmpFile('write');
    try {
      const result = await write.execute({ file_path: fp, content: 'hello world' });
      assert.strictEqual(result.success, true);
      assert.strictEqual(fs.readFileSync(fp, 'utf-8'), 'hello world');
    } finally {
      cleanup(fp);
    }
  });

  it('overwrites existing file', async () => {
    const fp = tmpFile('write-overwrite', 'old content');
    try {
      const result = await write.execute({ file_path: fp, content: 'new content' });
      assert.strictEqual(result.success, true);
      assert.strictEqual(fs.readFileSync(fp, 'utf-8'), 'new content');
    } finally {
      cleanup(fp);
    }
  });

  it('creates parent directories', async () => {
    const fp = path.join(os.tmpdir(), `oc-unit-nested-${Date.now()}`, 'sub', 'file.txt');
    try {
      const result = await write.execute({ file_path: fp, content: 'nested' });
      assert.strictEqual(result.success, true);
      assert.strictEqual(fs.readFileSync(fp, 'utf-8'), 'nested');
    } finally {
      cleanup(fp);
      // Clean up the nested dirs
      try { fs.rmSync(path.dirname(path.dirname(fp)), { recursive: true }); } catch { /* ignore */ }
    }
  });

  it('fails for missing file_path', async () => {
    const result = await write.execute({ content: 'x' });
    assert.strictEqual(result.success, false);
  });

  it('fails for missing content', async () => {
    const result = await write.execute({ file_path: '/tmp/x' });
    assert.strictEqual(result.success, false);
  });
});

// ─── Edit tool ──────────────────────────────────────────────────────────

describe('Edit tool', () => {
  const edit = getTool('Edit')!;

  it('replaces unique string', async () => {
    const fp = tmpFile('edit', 'foo bar baz\n');
    try {
      const result = await edit.execute({ file_path: fp, old_string: 'bar', new_string: 'qux' });
      assert.strictEqual(result.success, true);
      assert.strictEqual(fs.readFileSync(fp, 'utf-8'), 'foo qux baz\n');
    } finally {
      cleanup(fp);
    }
  });

  it('fails when old_string not found', async () => {
    const fp = tmpFile('edit-notfound', 'hello\n');
    try {
      const result = await edit.execute({ file_path: fp, old_string: 'missing', new_string: 'x' });
      assert.strictEqual(result.success, false);
      assert.ok(result.output.includes('not found'));
    } finally {
      cleanup(fp);
    }
  });

  it('fails when old_string is not unique and reports line numbers', async () => {
    const fp = tmpFile('edit-dup', 'aaa\nfoo\naaa\nbar\naaa\n');
    try {
      const result = await edit.execute({ file_path: fp, old_string: 'aaa', new_string: 'x' });
      assert.strictEqual(result.success, false);
      assert.ok(result.output.includes('3 times'));
      assert.ok(result.output.includes('lines 1, 3, 5'));
      assert.ok(result.output.toLowerCase().includes('surrounding context'));
    } finally {
      cleanup(fp);
    }
  });

  it('not-found error suggests re-reading', async () => {
    const fp = tmpFile('edit-not-found', 'hello world\n');
    try {
      const result = await edit.execute({ file_path: fp, old_string: 'goodbye', new_string: 'x' });
      assert.strictEqual(result.success, false);
      assert.match(result.output, /Re-read/i);
    } finally {
      cleanup(fp);
    }
  });

  it('reports the line of the matched edit on success', async () => {
    const fp = tmpFile('edit-line', 'foo\nbar\nbaz\n');
    try {
      const result = await edit.execute({ file_path: fp, old_string: 'bar', new_string: 'qux' });
      assert.strictEqual(result.success, true);
      assert.match(result.output, /line 2/);
    } finally {
      cleanup(fp);
    }
  });

  it('auto-corrects whitespace mismatch on a unique fuzzy match', async () => {
    // File uses 2/4/2 indents; model provides 0/2/0. Per-line indent differs across lines,
    // so no literal substring of the file matches old_string — fuzzy path required.
    const fileContent = '  if (x) {\n    return 1;\n  }\n';
    const fp = tmpFile('edit-fuzzy', fileContent);
    try {
      const wrongIndent = 'if (x) {\n  return 1;\n}';
      const newCode = 'if (x) {\n  return 2;\n}';
      const result = await edit.execute({ file_path: fp, old_string: wrongIndent, new_string: newCode });
      assert.strictEqual(result.success, true);
      assert.match(result.output, /auto-corrected/i);
      const updated = fs.readFileSync(fp, 'utf-8');
      assert.strictEqual(updated, '  if (x) {\n    return 2;\n  }\n');
    } finally {
      cleanup(fp);
    }
  });

  it('rejects an Edit that would produce invalid JSON, leaving the file unchanged', async () => {
    const before = '{\n  "scripts": {\n    "build": "tsc"\n  }\n}\n';
    const fp = tmpFile('edit-json-validate', before);
    fs.renameSync(fp, fp + '.json');
    const jsonFp = fp + '.json';
    try {
      // Inserting a sibling without a trailing comma would break JSON.
      const result = await edit.execute({
        file_path: jsonFp,
        old_string: '"scripts": {',
        new_string: '"scripts": {\n    "lint": "eslint ."',
      });
      assert.strictEqual(result.success, false);
      assert.match(result.output, /invalid JSON/);
      assert.match(result.output, /NOT modified/);
      // File on disk should be unchanged.
      assert.strictEqual(fs.readFileSync(jsonFp, 'utf-8'), before);
    } finally {
      try { fs.unlinkSync(jsonFp); } catch { /* ignore */ }
    }
  });

  it('reports ambiguous fuzzy matches without applying a change', async () => {
    const fileContent = "block A:\n  foo\n    bar\nblock B:\n      foo\n    bar\n";
    const fp = tmpFile('edit-fuzzy-multi', fileContent);
    try {
      const result = await edit.execute({
        file_path: fp,
        old_string: 'foo\nbar',
        new_string: 'baz\nqux',
      });
      assert.strictEqual(result.success, false);
      assert.match(result.output, /2 candidates|too ambiguous/i);
      assert.strictEqual(fs.readFileSync(fp, 'utf-8'), fileContent);
    } finally {
      cleanup(fp);
    }
  });

  it('fails for non-existent file', async () => {
    const result = await edit.execute({
      file_path: '/nonexistent/file.txt',
      old_string: 'a',
      new_string: 'b',
    });
    assert.strictEqual(result.success, false);
  });

  it('can replace with empty string (deletion)', async () => {
    const fp = tmpFile('edit-delete', 'keep remove keep\n');
    try {
      const result = await edit.execute({ file_path: fp, old_string: ' remove', new_string: '' });
      assert.strictEqual(result.success, true);
      assert.strictEqual(fs.readFileSync(fp, 'utf-8'), 'keep keep\n');
    } finally {
      cleanup(fp);
    }
  });
});

// ─── Bash tool ──────────────────────────────────────────────────────────

describe('Bash tool', () => {
  const bash = getTool('Bash')!;

  it('executes command and returns stdout', async () => {
    const result = await bash.execute({ command: 'echo hello' });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('hello'));
  });

  it('returns stderr alongside non-zero exit, but still success', async () => {
    const result = await bash.execute({ command: 'ls /nonexistent_dir_xyz' });
    // Command ran; non-zero exit is informational, not a tool failure.
    assert.strictEqual(result.success, true);
    assert.match(result.output, /exit code/);
  });

  it('fails for missing command', async () => {
    const result = await bash.execute({});
    assert.strictEqual(result.success, false);
    assert.ok(result.output.includes('required'));
  });

  it('captures exit code 0 as success with no exit-code header', async () => {
    const result = await bash.execute({ command: 'true' });
    assert.strictEqual(result.success, true);
    assert.doesNotMatch(result.output, /exit code/);
  });

  it('non-zero exit reports success=true with exit code in output', async () => {
    const result = await bash.execute({ command: 'false' });
    assert.strictEqual(result.success, true);
    assert.match(result.output, /exit code 1/);
  });
});

// ─── Glob tool ──────────────────────────────────────────────────────────

describe('Glob tool', () => {
  const glob = getTool('Glob')!;

  it('finds files matching pattern', async () => {
    // From dist-test/test/unit/ -> project root is 3 levels up
    const projectRoot = path.resolve(__dirname, '..', '..', '..');
    const result = await glob.execute({ pattern: 'package.json', path: projectRoot });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('package.json'));
  });

  it('returns no match message for unmatched pattern', async () => {
    const result = await glob.execute({ pattern: '*.nonexistent_extension_xyz', path: os.tmpdir() });
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
  const grep = getTool('Grep')!;

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
});
