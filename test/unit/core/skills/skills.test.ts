import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseFrontmatter,
  loadSkillMetadata,
  loadSkillBody,
  loadSkills,
} from '../../../../src/core/skills/loader.js';
import { SkillsRegistry } from '../../../../src/core/skills/index.js';
import type { SkillScope } from '../../../../src/core/skills/scopes.js';
import type { Skill } from '../../../../src/core/skills/loader.js';

// ---------- parseFrontmatter ----------

describe('parseFrontmatter', () => {
  it('parses scalars, booleans, and inline arrays', () => {
    const fm = parseFrontmatter(
      [
        'name: my-skill',
        'description: hello world',
        'alwaysOn: true',
        'allowed-tools: [Bash, Read]',
      ].join('\n'),
    );
    assert.strictEqual(fm['name'], 'my-skill');
    assert.strictEqual(fm['description'], 'hello world');
    assert.strictEqual(fm['alwaysOn'], true);
    assert.deepStrictEqual(fm['allowed-tools'], ['Bash', 'Read']);
  });

  it('parses block-style string arrays with hyphenated key', () => {
    const fm = parseFrontmatter(
      ['disallowed-tools:', '  - AskUserQuestion', '  - Write'].join('\n'),
    );
    assert.deepStrictEqual(fm['disallowed-tools'], ['AskUserQuestion', 'Write']);
  });

  it('parses hyphenated keys without error', () => {
    const fm = parseFrontmatter('disable-model-invocation: true\nwhen_to_use: testing\n');
    assert.strictEqual(fm['disable-model-invocation'], true);
    assert.strictEqual(fm['when_to_use'], 'testing');
  });
});

// ---------- loadSkillMetadata ----------

const PERSONAL_SCOPE: SkillScope = { kind: 'personal', root: '/fake' };

function makeRaw(frontmatter: string, body = 'skill body here'): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

describe('loadSkillMetadata', () => {
  it('parses a minimal skill', () => {
    const raw = makeRaw('description: A helpful skill');
    const skill = loadSkillMetadata(raw, '/skills/hello', PERSONAL_SCOPE);
    assert.strictEqual(skill.name, 'hello'); // derived from dir name
    assert.strictEqual(skill.description, 'A helpful skill');
    assert.strictEqual(skill.alwaysOn, false);
    assert.strictEqual(skill.userInvocable, true);
    assert.strictEqual(skill.disableModelInvocation, false);
    assert.strictEqual(skill.context, 'current');
    assert.ok(skill.metadataOnly);
    assert.strictEqual(skill.body, undefined);
  });

  it('parses all new fields', () => {
    const raw = makeRaw(
      [
        'name: deploy',
        'description: Deploy the app',
        'when_to_use: when deploying',
        'argument-hint: <env>',
        'arguments: [env, tag]',
        'allowed-tools: [Bash]',
        'disallowed-tools: [Write]',
        'disable-model-invocation: true',
        'user-invocable: true',
        'model: claude-sonnet-4-6',
        'effort: high',
        'context: fork',
        'agent: Explore',
        'paths: [src/**]',
        'shell: bash',
        'alwaysOn: false',
      ].join('\n'),
    );
    const skill = loadSkillMetadata(raw, '/skills/deploy', PERSONAL_SCOPE);
    assert.strictEqual(skill.name, 'deploy');
    assert.strictEqual(skill.whenToUse, 'when deploying');
    assert.strictEqual(skill.argumentHint, '<env>');
    assert.deepStrictEqual(skill.argumentNames, ['env', 'tag']);
    assert.deepStrictEqual(skill.allowedTools, ['Bash']);
    assert.deepStrictEqual(skill.disallowedTools, ['Write']);
    assert.strictEqual(skill.disableModelInvocation, true);
    assert.strictEqual(skill.userInvocable, true);
    assert.strictEqual(skill.model, 'claude-sonnet-4-6');
    assert.strictEqual(skill.effort, 'high');
    assert.strictEqual(skill.context, 'fork');
    assert.strictEqual(skill.agent, 'Explore');
    assert.deepStrictEqual(skill.paths, ['src/**']);
    assert.strictEqual(skill.shell, 'bash');
    assert.strictEqual(skill.alwaysOn, false);
  });

  it('throws on missing YAML frontmatter', () => {
    assert.throws(
      () => loadSkillMetadata('no frontmatter here', '/skills/bad', PERSONAL_SCOPE),
      /missing YAML frontmatter/,
    );
  });

  it('throws on invalid context value', () => {
    assert.throws(
      () =>
        loadSkillMetadata(
          makeRaw('description: x\ncontext: parallel'),
          '/skills/bad',
          PERSONAL_SCOPE,
        ),
      /"context"/,
    );
  });

  it('namespaces plugin skills', () => {
    const pluginScope: SkillScope = {
      kind: 'plugin',
      root: '/plugins/p/skills',
      pluginName: 'myplugin',
    };
    const raw = makeRaw('description: Plugin skill', 'body');
    const skill = loadSkillMetadata(raw, '/plugins/p/skills/foo', pluginScope);
    assert.strictEqual(skill.name, 'myplugin:foo');
    assert.strictEqual(skill.scope, 'plugin');
    assert.strictEqual(skill.pluginName, 'myplugin');
  });
});

// ---------- loadSkillBody ----------

describe('loadSkillBody', () => {
  it('reads and caches the body from SKILL.md', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-skills-'));
    try {
      const skillDir = path.join(root, 'hello');
      await fs.mkdir(skillDir);
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        ['---', 'description: hi', '---', 'hello world body'].join('\n'),
      );
      const raw = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
      const skill = loadSkillMetadata(raw, skillDir, PERSONAL_SCOPE);
      assert.ok(skill.metadataOnly);
      const body = await loadSkillBody(skill);
      assert.strictEqual(body, 'hello world body');
      assert.strictEqual(skill.metadataOnly, false);
      assert.strictEqual(skill.body, 'hello world body');

      // Second call returns cached value without re-reading.
      const body2 = await loadSkillBody(skill);
      assert.strictEqual(body2, 'hello world body');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// ---------- loadSkills (directory layout) ----------

describe('loadSkills', () => {
  it('loads skills from directory layout', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-skills-'));
    const fakeHome = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    await fs.mkdir(path.join(fakeHome, '.factory', 'skills', 'greet'), { recursive: true });
    await fs.mkdir(path.join(cwd, '.factory', 'skills'), { recursive: true });

    await fs.writeFile(
      path.join(fakeHome, '.factory', 'skills', 'greet', 'SKILL.md'),
      ['---', 'description: Personal greet skill', '---', 'personal body'].join('\n'),
    );

    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const { skills, warnings } = await loadSkills(cwd);
      assert.strictEqual(skills.length, 1);
      assert.strictEqual(skills[0]!.name, 'greet');
      assert.strictEqual(skills[0]!.scope, 'personal');
      assert.strictEqual(warnings.length, 0);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('personal skills override project skills by name (spec §4: Personal > Project)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-skills-'));
    const fakeHome = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    await fs.mkdir(path.join(fakeHome, '.factory', 'skills', 'shared'), { recursive: true });
    await fs.mkdir(path.join(cwd, '.factory', 'skills', 'shared'), { recursive: true });

    await fs.writeFile(
      path.join(fakeHome, '.factory', 'skills', 'shared', 'SKILL.md'),
      ['---', 'description: personal version', '---', 'personal body'].join('\n'),
    );
    await fs.writeFile(
      path.join(cwd, '.factory', 'skills', 'shared', 'SKILL.md'),
      ['---', 'description: project version', '---', 'project body'].join('\n'),
    );

    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const { skills } = await loadSkills(cwd);
      assert.strictEqual(skills.length, 1);
      // Spec §4 precedence: Enterprise > Personal > Project.
      // Personal loads after project in the map, so personal wins.
      assert.strictEqual(skills[0]!.scope, 'personal');
      assert.strictEqual(skills[0]!.description, 'personal version');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('warns about flat .md files (legacy layout) but does not load them', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-skills-'));
    const cwd = path.join(root, 'project');
    await fs.mkdir(path.join(cwd, '.factory', 'skills'), { recursive: true });

    // Flat file (legacy) alongside a valid dir-based skill.
    await fs.writeFile(
      path.join(cwd, '.factory', 'skills', 'old.md'),
      ['---', 'description: legacy', '---', 'body'].join('\n'),
    );
    await fs.mkdir(path.join(cwd, '.factory', 'skills', 'new'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.factory', 'skills', 'new', 'SKILL.md'),
      ['---', 'description: new style', '---', 'body'].join('\n'),
    );

    const prevHome = process.env.HOME;
    process.env.HOME = root; // empty home — no personal skills
    try {
      const { skills, warnings } = await loadSkills(cwd);
      assert.strictEqual(skills.length, 1);
      assert.strictEqual(skills[0]!.name, 'new');
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0]!, /old\.md/);
      assert.match(warnings[0]!, /directory-per-skill/);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports a warning for malformed SKILL.md but continues', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-skills-'));
    const cwd = path.join(root, 'project');
    await fs.mkdir(path.join(cwd, '.factory', 'skills', 'good'), { recursive: true });
    await fs.mkdir(path.join(cwd, '.factory', 'skills', 'bad'), { recursive: true });

    await fs.writeFile(
      path.join(cwd, '.factory', 'skills', 'good', 'SKILL.md'),
      ['---', 'description: ok', '---', 'body'].join('\n'),
    );
    await fs.writeFile(
      path.join(cwd, '.factory', 'skills', 'bad', 'SKILL.md'),
      'no frontmatter at all',
    );

    const prevHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const { skills, warnings } = await loadSkills(cwd);
      assert.strictEqual(skills.length, 1);
      assert.strictEqual(skills[0]!.name, 'good');
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0]!, /bad/);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// ---------- SkillsRegistry ----------

describe('SkillsRegistry', () => {
  function makeSkill(overrides: Partial<Skill> = {}): Skill {
    return {
      name: 'test',
      description: 'A test skill',
      argumentNames: [],
      allowedTools: [],
      disallowedTools: [],
      disableModelInvocation: false,
      userInvocable: true,
      context: 'current' as const,
      paths: [],
      alwaysOn: false,
      scope: 'personal' as const,
      sourceDir: '/skills/test',
      metadataOnly: false,
      body: 'skill body',
      ...overrides,
    };
  }

  it('catalogSection includes non-disabled skills', () => {
    const reg = new SkillsRegistry([
      makeSkill({ name: 'deploy', description: 'Deploy the app', whenToUse: 'deploying' }),
      makeSkill({ name: 'hidden', description: 'Secret', disableModelInvocation: true }),
    ]);
    const catalog = reg.catalogSection();
    assert.match(catalog, /deploy/);
    assert.match(catalog, /deploying/);
    assert.doesNotMatch(catalog, /hidden/);
  });

  it('alwaysOnSection only includes always-on skills with bodies', () => {
    const reg = new SkillsRegistry([
      makeSkill({ name: 'on', alwaysOn: true, body: 'always content' }),
      makeSkill({ name: 'off', alwaysOn: false, body: 'cond content' }),
      makeSkill({ name: 'on-nobody', alwaysOn: true, body: undefined, metadataOnly: true }),
    ]);
    const section = reg.alwaysOnSection();
    assert.match(section, /always content/);
    assert.doesNotMatch(section, /cond content/);
    assert.doesNotMatch(section, /on-nobody/);
  });

  it('find returns skill by name', () => {
    const reg = new SkillsRegistry([makeSkill({ name: 'foo' })]);
    assert.ok(reg.find('foo'));
    assert.strictEqual(reg.find('bar'), undefined);
  });

  it('evaluate and recordToolUsed are no-ops (model-driven path)', () => {
    const reg = new SkillsRegistry([makeSkill()]);
    assert.deepStrictEqual(reg.evaluate('docker question'), []);
    assert.doesNotThrow(() => reg.recordToolUsed('Bash'));
  });
});
