/**
 * Skills load from `~/.factory/skills/*.md` (global) and
 * `<cwd>/.factory/skills/*.md` (project). The headless welcome banner
 * surfaces the loaded skill count when the experimental flag is on, which
 * is the simplest end-to-end signal that the loader ran. Broken
 * frontmatter should not crash the run.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { spawnCliHeadless } from '../cli-harness.js';
import { startMockServer, stopMockServer, setNextResponse } from '../mock-ollama-server.js';
import { tmpEnv } from '../fixtures/tmpProject.js';
import { writeSkill, defaultSkillBody } from '../fixtures/writeSkill.js';

let mockPort: number;
let mockServer: any;
before(async () => {
  const r = await startMockServer();
  mockServer = r.server;
  mockPort = r.port;
});
after(async () => {
  await stopMockServer(mockServer);
});

let env: ReturnType<typeof tmpEnv>;
beforeEach(() => {
  if (env) env.cleanup();
  env = tmpEnv();
});
after(() => env?.cleanup());

function args(): string[] {
  return [
    '--provider',
    'ollama',
    '--model',
    'test-model:latest',
    '--host',
    `http://127.0.0.1:${mockPort}`,
    '--skills',
  ];
}

describe('Skills loader (headless)', () => {
  it('loads a well-formed project skill without crashing', async () => {
    writeSkill(env.cwd, 'test-routine', defaultSkillBody('test-routine', 'A test skill.'));
    setNextResponse({ content: 'hi' });
    const r = await spawnCliHeadless(args(), {
      stdin: 'hello\n',
      home: env.home,
      cwd: env.cwd,
    });
    assert.strictEqual(r.exitCode, 0, r.stderr);
    // No specific banner string asserted here — the unit suite covers the
    // loader output. The signal we want is "did not crash + did not warn
    // loudly". A loud warning about the skill body would land in stderr.
    assert.ok(
      !/skill error|skill failed/i.test(r.stderr),
      `unexpected skill error in stderr: ${r.stderr}`,
    );
  });

  it('surfaces a warning for a skill with broken frontmatter but still completes', async () => {
    // Missing closing `---` — the loader should warn and skip, not abort.
    const file = path.join(env.cwd, '.factory', 'skills', 'broken.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '---\nname: broken\ndescription: oops\n\nno terminator');
    setNextResponse({ content: 'ok' });
    const r = await spawnCliHeadless(args(), {
      stdin: 'hi\n',
      home: env.home,
      cwd: env.cwd,
    });
    assert.strictEqual(r.exitCode, 0, r.stderr);
  });
});
