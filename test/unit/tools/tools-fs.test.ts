import { describe, it } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { defaultRegistry } from '../../../src/tools/index.js';
import { cleanup, makeSymlink, tmpFile } from './tools-helpers.js';

// ─── Read tool ──────────────────────────────────────────────────────────

describe('Read tool', () => {
  const read = defaultRegistry.get('Read')!;

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

  it('lists directory entries when the path is a directory', async () => {
    const dir = path.join(os.tmpdir(), `oc-unit-readdir-${crypto.randomUUID()}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'b.txt'), '');
    fs.writeFileSync(path.join(dir, 'a.txt'), '');
    fs.mkdirSync(path.join(dir, 'sub'));
    try {
      const result = await read.execute({ file_path: dir });
      assert.strictEqual(result.success, true);
      // Sorted alphabetically; subdirectories suffixed with `/`.
      assert.match(result.output, /a\.txt\nb\.txt\nsub\//);
      assert.ok(!result.output.includes('EISDIR'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an empty directory clearly', async () => {
    const dir = path.join(os.tmpdir(), `oc-unit-readdir-empty-${crypto.randomUUID()}`);
    fs.mkdirSync(dir);
    try {
      const result = await read.execute({ file_path: dir });
      assert.strictEqual(result.success, true);
      assert.match(result.output, /empty directory/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Write tool ─────────────────────────────────────────────────────────

describe('Write tool', () => {
  const write = defaultRegistry.get('Write')!;

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
      try {
        fs.rmSync(path.dirname(path.dirname(fp)), { recursive: true });
      } catch {
        /* ignore */
      }
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

  it('rejects non-string content (number, object, array)', async () => {
    const fp = tmpFile('write-typecheck');
    try {
      for (const bad of [123, { foo: 'bar' }, ['a', 'b'], true]) {
        const result = await write.execute({ file_path: fp, content: bad });
        assert.strictEqual(result.success, false, `should reject ${typeof bad}`);
        assert.ok(
          result.output.includes('must be a string'),
          `wrong message for ${typeof bad}: ${result.output}`,
        );
      }
    } finally {
      cleanup(fp);
    }
  });
});

// ─── Edit tool ──────────────────────────────────────────────────────────

describe('Edit tool', () => {
  const edit = defaultRegistry.get('Edit')!;

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
      const result = await edit.execute({
        file_path: fp,
        old_string: wrongIndent,
        new_string: newCode,
      });
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
      try {
        fs.unlinkSync(jsonFp);
      } catch {
        /* ignore */
      }
    }
  });

  it('reports ambiguous fuzzy matches without applying a change', async () => {
    const fileContent = 'block A:\n  foo\n    bar\nblock B:\n      foo\n    bar\n';
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

  it('treats $-patterns in new_string literally (not as regex backrefs)', async () => {
    // String.prototype.replace with a string replacement interprets $1, $&,
    // $', $`, $$ — a model writing a shell snippet, regex example, or a
    // dollar-amount would otherwise see those characters mangled. The fix
    // is a function replacer; this test guards against regressing it.
    const cases = [
      'price = $1.50',
      'echo "$&" && exit',
      'literal $$ dollars',
      "preceding $` and trailing $'",
    ];
    for (const newStr of cases) {
      const fp = tmpFile('edit-dollar', 'X: PLACEHOLDER\n');
      try {
        const result = await edit.execute({
          file_path: fp,
          old_string: 'PLACEHOLDER',
          new_string: newStr,
        });
        assert.strictEqual(result.success, true, `edit failed for ${newStr}`);
        assert.strictEqual(
          fs.readFileSync(fp, 'utf-8'),
          `X: ${newStr}\n`,
          `wrong content for ${newStr}`,
        );
      } finally {
        cleanup(fp);
      }
    }
  });
});

// ─── File tool symlink behavior ─────────────────────────────────────────
// Pin down current behavior: Read/Write/Edit follow symlinks and operate on
// the target. There is no project-root jail. If a jail is added later, these
// flip to negative assertions — that's the point.

describe('File tool symlink behavior', () => {
  const read = defaultRegistry.get('Read')!;
  const write = defaultRegistry.get('Write')!;
  const edit = defaultRegistry.get('Edit')!;

  it('Read follows a symlink to its target', async () => {
    const target = tmpFile('symlink-read-target', 'target-content\n');
    const link = makeSymlink(target, 'read');
    try {
      const result = await read.execute({ file_path: link });
      assert.strictEqual(result.success, true);
      assert.ok(result.output.includes('target-content'));
    } finally {
      cleanup(link);
      cleanup(target);
    }
  });

  it('Write through a symlink overwrites the target file, not the link', async () => {
    const target = tmpFile('symlink-write-target', 'old\n');
    const link = makeSymlink(target, 'write');
    try {
      const result = await write.execute({ file_path: link, content: 'new content' });
      assert.strictEqual(result.success, true);
      // The target file was modified...
      assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'new content');
      // ...and the link is still a symlink (not replaced by a regular file).
      assert.ok(fs.lstatSync(link).isSymbolicLink());
    } finally {
      cleanup(link);
      cleanup(target);
    }
  });

  it('Edit through a symlink modifies the target file', async () => {
    const target = tmpFile('symlink-edit-target', 'foo bar baz\n');
    const link = makeSymlink(target, 'edit');
    try {
      const result = await edit.execute({ file_path: link, old_string: 'bar', new_string: 'qux' });
      assert.strictEqual(result.success, true);
      assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'foo qux baz\n');
      assert.ok(fs.lstatSync(link).isSymbolicLink());
    } finally {
      cleanup(link);
      cleanup(target);
    }
  });

  it('Read via a symlink that escapes cwd succeeds (no project-root jail)', async () => {
    // Create a directory outside cwd and a file inside it; symlink it from
    // a different directory. Read via the symlink to prove there's no jail.
    const outsideDir = path.join(os.tmpdir(), `oc-unit-outside-${crypto.randomUUID()}`);
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'outside-the-jail\n');
    const link = makeSymlink(outsideFile, 'escape');
    try {
      const result = await read.execute({ file_path: link });
      assert.strictEqual(result.success, true);
      assert.ok(result.output.includes('outside-the-jail'));
    } finally {
      cleanup(link);
      cleanup(outsideFile);
      try {
        fs.rmSync(outsideDir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  });
});
