import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseSkillFile, parseFrontmatter, loadSkills } from '../../../../src/core/skills/loader.js';
import { shouldInjectSkill } from '../../../../src/core/skills/matcher.js';
import { SkillsRegistry } from '../../../../src/core/skills/index.js';

describe('parseFrontmatter', () => {
  it('parses scalars, booleans, and inline arrays', () => {
    const fm = parseFrontmatter(
      ['name: my-skill', 'description: hello world', 'alwaysOn: true', 'tools: [Bash, Read]'].join(
        '\n',
      ),
    );
    assert.strictEqual(fm.name, 'my-skill');
    assert.strictEqual(fm.description, 'hello world');
    assert.strictEqual(fm.alwaysOn, true);
    assert.deepStrictEqual(fm.tools, ['Bash', 'Read']);
  });

  it('parses block-style string arrays with quoted entries', () => {
    const fm = parseFrontmatter(
      ['triggers:', '  - "\\\\bdocker\\\\b"', '  - container'].join('\n'),
    );
    assert.deepStrictEqual(fm.triggers, ['\\bdocker\\b', 'container']);
  });
});

describe('parseSkillFile', () => {
  it('parses a valid skill file', () => {
    const raw = [
      '---',
      'name: docker-help',
      'description: Tips for working with docker',
      'triggers:',
      '  - "\\\\bdocker\\\\b"',
      'tools: [Bash]',
      '---',
      'Use docker compose, not docker-compose.',
    ].join('\n');
    const skill = parseSkillFile(raw, '/tmp/docker-help.md', 'project');
    assert.ok(skill);
    assert.strictEqual(skill.name, 'docker-help');
    assert.strictEqual(skill.alwaysOn, false);
    assert.deepStrictEqual(skill.triggers, ['\\bdocker\\b']);
    assert.deepStrictEqual(skill.tools, ['Bash']);
    assert.strictEqual(skill.body, 'Use docker compose, not docker-compose.');
    assert.strictEqual(skill.scope, 'project');
  });

  it('throws on missing frontmatter', () => {
    const raw = 'No frontmatter here, just a body.\n';
    assert.throws(() => parseSkillFile(raw, '/tmp/bad.md', 'project'), /missing YAML frontmatter/);
  });

  it('throws on missing required name', () => {
    const raw = ['---', 'description: hi', '---', 'body'].join('\n');
    assert.throws(() => parseSkillFile(raw, '/tmp/bad.md', 'project'), /name/);
  });

  it('throws on bad regex in triggers', () => {
    const raw = [
      '---',
      'name: bad-regex',
      'description: x',
      'triggers: ["[unterminated"]',
      '---',
      'body',
    ].join('\n');
    assert.throws(() => parseSkillFile(raw, '/tmp/bad.md', 'project'), /invalid regex/);
  });
});

describe('shouldInjectSkill', () => {
  const skill = {
    name: 'docker',
    description: '',
    alwaysOn: false,
    triggers: ['\\bdocker\\b'],
    tools: [],
    body: 'b',
    sourcePath: '',
    scope: 'project' as const,
  };

  it('matches when the user message contains the trigger', () => {
    assert.strictEqual(
      shouldInjectSkill(skill, {
        userMessage: 'how do I use docker compose?',
        recentToolNames: [],
      }),
      true,
    );
  });

  it('does not match when the trigger is absent', () => {
    assert.strictEqual(
      shouldInjectSkill(skill, { userMessage: 'unrelated question', recentToolNames: [] }),
      false,
    );
  });

  it('skips alwaysOn skills (they live in the system prompt)', () => {
    assert.strictEqual(
      shouldInjectSkill(
        { ...skill, alwaysOn: true },
        { userMessage: 'docker', recentToolNames: [] },
      ),
      false,
    );
  });

  it('with `tools:` set, requires recent-tool intersection', () => {
    const withTools = { ...skill, tools: ['Bash'] };
    assert.strictEqual(
      shouldInjectSkill(withTools, { userMessage: 'docker', recentToolNames: ['Read'] }),
      false,
    );
    assert.strictEqual(
      shouldInjectSkill(withTools, { userMessage: 'docker', recentToolNames: ['Bash'] }),
      true,
    );
  });
});

describe('SkillsRegistry', () => {
  it('alwaysOnSection concatenates only always-on bodies', () => {
    const reg = new SkillsRegistry([
      {
        name: 'on-1',
        description: 'd',
        alwaysOn: true,
        triggers: [],
        tools: [],
        body: 'always 1',
        sourcePath: '',
        scope: 'project',
      },
      {
        name: 'cond-1',
        description: 'd',
        alwaysOn: false,
        triggers: ['x'],
        tools: [],
        body: 'cond',
        sourcePath: '',
        scope: 'project',
      },
    ]);
    const text = reg.alwaysOnSection();
    assert.match(text, /## Skills/);
    assert.match(text, /always 1/);
    assert.doesNotMatch(text, /cond/);
  });

  it('evaluate de-duplicates the same skill firing twice in a row', () => {
    const reg = new SkillsRegistry([
      {
        name: 's',
        description: 'd',
        alwaysOn: false,
        triggers: ['docker'],
        tools: [],
        body: 'tip',
        sourcePath: '',
        scope: 'project',
      },
    ]);
    const a = reg.evaluate('docker question');
    const b = reg.evaluate('docker again');
    assert.strictEqual(a.length, 1);
    assert.strictEqual(b.length, 0);
  });
});

describe('loadSkills', () => {
  it('lets project skills override global skills sharing the same name', async () => {
    // Stage temp directory layout that mimics ~/.factory/skills + cwd/.factory/skills.
    // We point HOME at a tempdir so the loader picks up the synthetic global file.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-skills-'));
    const fakeHome = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    await fs.mkdir(path.join(fakeHome, '.factory', 'skills'), { recursive: true });
    await fs.mkdir(path.join(cwd, '.factory', 'skills'), { recursive: true });

    await fs.writeFile(
      path.join(fakeHome, '.factory', 'skills', 'shared.md'),
      ['---', 'name: shared', 'description: global version', '---', 'GLOBAL BODY'].join('\n'),
    );
    await fs.writeFile(
      path.join(cwd, '.factory', 'skills', 'shared.md'),
      ['---', 'name: shared', 'description: project version', '---', 'PROJECT BODY'].join('\n'),
    );

    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const { skills } = await loadSkills(cwd);
      assert.strictEqual(skills.length, 1);
      assert.strictEqual(skills[0].scope, 'project');
      assert.strictEqual(skills[0].body, 'PROJECT BODY');
      assert.strictEqual(skills[0].description, 'project version');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports a warning for malformed files instead of throwing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-skills-'));
    const fakeHome = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    await fs.mkdir(path.join(cwd, '.factory', 'skills'), { recursive: true });

    await fs.writeFile(
      path.join(cwd, '.factory', 'skills', 'good.md'),
      ['---', 'name: good', 'description: ok', '---', 'body'].join('\n'),
    );
    // No frontmatter delimiters at all → should warn, not throw.
    await fs.writeFile(path.join(cwd, '.factory', 'skills', 'broken.md'), 'just a body, no fence');

    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const { skills, warnings } = await loadSkills(cwd);
      assert.strictEqual(skills.length, 1);
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0], /broken\.md/);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
