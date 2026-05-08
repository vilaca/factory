import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { extractProjectFacts } from '../../src/core/project-facts.js';

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `oc-facts-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('extractProjectFacts', () => {
  it('returns null for an empty directory', async () => {
    const dir = tmpDir();
    try {
      const facts = await extractProjectFacts(dir);
      assert.strictEqual(facts, null);
    } finally {
      cleanup(dir);
    }
  });

  it('extracts package.json engines, type, and scripts', async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: 'demo',
          version: '1.2.3',
          engines: { node: '>=18' },
          type: 'module',
          main: 'dist/index.js',
          scripts: { build: 'tsc', test: 'node --test', start: 'node dist/index.js', other: 'x' },
        }),
      );
      const facts = await extractProjectFacts(dir);
      assert.ok(facts);
      assert.match(facts!, /demo@1\.2\.3/);
      assert.match(facts!, />=18/);
      assert.match(facts!, /module/);
      assert.match(facts!, /dist\/index\.js/);
      assert.match(facts!, /`build`/);
      assert.match(facts!, /`test`/);
      assert.match(facts!, /`start`/);
      // 'other' isn't in the curated script keys
      assert.doesNotMatch(facts!, /`other`/);
    } finally {
      cleanup(dir);
    }
  });

  it('extracts tsconfig.json options (handling JSON comments)', async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, 'tsconfig.json'),
        `{
  // line comment
  "compilerOptions": {
    /* block comment */
    "target": "ES2022",
    "module": "NodeNext",
    "strict": true,
    "outDir": "dist"
  }
}`,
      );
      const facts = await extractProjectFacts(dir);
      assert.ok(facts);
      assert.match(facts!, /ES2022/);
      assert.match(facts!, /NodeNext/);
      assert.match(facts!, /strict: true/);
      assert.match(facts!, /outDir: dist/);
    } finally {
      cleanup(dir);
    }
  });

  it('reports python markers when present', async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname="x"\n');
      const facts = await extractProjectFacts(dir);
      assert.ok(facts);
      assert.match(facts!, /pyproject\.toml/);
    } finally {
      cleanup(dir);
    }
  });
});
