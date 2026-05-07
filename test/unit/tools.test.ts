import { describe, it } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { defaultRegistry } from '../../src/tools/index.js';
import { __testing as bashTesting } from '../../src/tools/bash.js';

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

  it('rejects non-string content (number, object, array)', async () => {
    const fp = tmpFile('write-typecheck');
    try {
      for (const bad of [123, { foo: 'bar' }, ['a', 'b'], true]) {
        const result = await write.execute({ file_path: fp, content: bad });
        assert.strictEqual(result.success, false, `should reject ${typeof bad}`);
        assert.ok(result.output.includes('must be a string'), `wrong message for ${typeof bad}: ${result.output}`);
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
        const result = await edit.execute({ file_path: fp, old_string: 'PLACEHOLDER', new_string: newStr });
        assert.strictEqual(result.success, true, `edit failed for ${newStr}`);
        assert.strictEqual(fs.readFileSync(fp, 'utf-8'), `X: ${newStr}\n`, `wrong content for ${newStr}`);
      } finally {
        cleanup(fp);
      }
    }
  });
});

// ─── Bash tool ──────────────────────────────────────────────────────────

describe('Bash tool', () => {
  const bash = defaultRegistry.get('Bash')!;

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

  // The following pin down the documented behavior: Bash invokes /bin/sh -c
  // with no parsing or quoting, so all shell metacharacters work as expected.
  // If we ever add a sanitizer/parser, these flip to negative assertions.

  it('$(...) command substitution is evaluated by /bin/sh', async () => {
    const result = await bash.execute({ command: 'echo $(echo nested)' });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('nested'));
  });

  it('backtick command substitution is evaluated by /bin/sh', async () => {
    const result = await bash.execute({ command: 'echo `echo back`' });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('back'));
  });

  it('; chains multiple commands', async () => {
    const result = await bash.execute({ command: 'echo first; echo second' });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('first'));
    assert.ok(result.output.includes('second'));
  });

  it('pipes stdout between commands', async () => {
    const result = await bash.execute({ command: 'printf "a\\nb\\nc\\n" | wc -l' });
    assert.strictEqual(result.success, true);
    assert.match(result.output, /\b3\b/);
  });

  it('clamps the timeout parameter to [MIN, MAX]', () => {
    const { clampTimeout, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } = bashTesting;
    // Invalid input (non-finite, non-numeric) → default. Pretending to honor
    // ±Infinity by clamping to MAX/MIN would mask a malformed model call.
    assert.strictEqual(clampTimeout(undefined), DEFAULT_TIMEOUT_MS);
    assert.strictEqual(clampTimeout(null), DEFAULT_TIMEOUT_MS);
    assert.strictEqual(clampTimeout(NaN), DEFAULT_TIMEOUT_MS);
    assert.strictEqual(clampTimeout(Infinity), DEFAULT_TIMEOUT_MS);
    assert.strictEqual(clampTimeout(-Infinity), DEFAULT_TIMEOUT_MS);
    assert.strictEqual(clampTimeout('not a number'), DEFAULT_TIMEOUT_MS);
    // Finite values clamp to [MIN, MAX]. 0 would otherwise disable the
    // timeout entirely (Node treats falsy as no timeout) — the main reason
    // we clamp at all.
    assert.strictEqual(clampTimeout(0), MIN_TIMEOUT_MS);
    assert.strictEqual(clampTimeout(-5000), MIN_TIMEOUT_MS);
    assert.strictEqual(clampTimeout(MAX_TIMEOUT_MS + 1), MAX_TIMEOUT_MS);
    assert.strictEqual(clampTimeout(5000), 5000);
  });
});

// ─── Glob tool ──────────────────────────────────────────────────────────

describe('Glob tool', () => {
  const glob = defaultRegistry.get('Glob')!;

  it('finds files matching pattern', async () => {
    const result = await glob.execute({ pattern: 'package.json', path: process.cwd() });
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
      const result = await grep.execute({ pattern: 'hit-marker-zzz', path: tmp, include_content: true });
      assert.strictEqual(result.success, true);
      const outLines = result.output.split('\n');
      // Footer line + cap of 1000 = 1001 lines total.
      assert.strictEqual(outLines.length, 1001, `expected 1001 lines, got ${outLines.length}`);
      assert.ok(result.output.includes('truncated'), `expected truncation footer in: ${result.output.slice(-200)}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── File tool symlink behavior ─────────────────────────────────────────
// Pin down current behavior: Read/Write/Edit follow symlinks and operate on
// the target. There is no project-root jail. If a jail is added later, these
// flip to negative assertions — that's the point.

function makeSymlink(target: string, suffix: string): string {
  const link = path.join(os.tmpdir(), `oc-unit-link-${suffix}-${crypto.randomUUID()}`);
  fs.symlinkSync(target, link);
  return link;
}

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
      try { fs.rmSync(outsideDir, { recursive: true }); } catch { /* ignore */ }
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
      assert.ok(result.output.includes('suppressed'), `expected suppression note in: ${result.output}`);
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
      assert.ok(result.output.includes('suppressed'), `expected suppression note in: ${result.output}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
