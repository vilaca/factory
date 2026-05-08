import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sanitizeEnv } from '../../src/security/env.js';

describe('sanitizeEnv', () => {
  it('drops unknown vars by default', () => {
    const { env, dropped } = sanitizeEnv({
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      OPENAI_API_KEY: 'sk-openai',
      AWS_SECRET_ACCESS_KEY: 'aws',
      GITHUB_TOKEN: 'ghp_xxx',
    });
    assert.strictEqual(env.ANTHROPIC_API_KEY, undefined);
    assert.strictEqual(env.OPENAI_API_KEY, undefined);
    assert.strictEqual(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.strictEqual(env.GITHUB_TOKEN, undefined);
    assert.deepStrictEqual(dropped.sort(), [
      'ANTHROPIC_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
    ]);
  });

  it('keeps the default allowlist', () => {
    const { env } = sanitizeEnv({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      USER: 'me',
      SHELL: '/bin/zsh',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      EDITOR: 'vim',
      SECRET_TOKEN: 'should drop',
    });
    assert.strictEqual(env.PATH, '/usr/bin');
    assert.strictEqual(env.HOME, '/Users/me');
    assert.strictEqual(env.USER, 'me');
    assert.strictEqual(env.SHELL, '/bin/zsh');
    assert.strictEqual(env.LANG, 'en_US.UTF-8');
    assert.strictEqual(env.EDITOR, 'vim');
    assert.strictEqual(env.SECRET_TOKEN, undefined);
  });

  it('keeps prefix-allowed vars (LC_*, GIT_*, XDG_*)', () => {
    const { env } = sanitizeEnv({
      LC_ALL: 'C',
      LC_CTYPE: 'UTF-8',
      GIT_AUTHOR_NAME: 'me',
      GIT_DIR: '.git',
      XDG_CONFIG_HOME: '/Users/me/.config',
      LCMARKETING: 'should drop', // not LC_, just LC
    });
    assert.strictEqual(env.LC_ALL, 'C');
    assert.strictEqual(env.LC_CTYPE, 'UTF-8');
    assert.strictEqual(env.GIT_AUTHOR_NAME, 'me');
    assert.strictEqual(env.GIT_DIR, '.git');
    assert.strictEqual(env.XDG_CONFIG_HOME, '/Users/me/.config');
    assert.strictEqual(env.LCMARKETING, undefined);
  });

  it('built-in deny wins over allow-prefix (GIT_ASKPASS)', () => {
    const { env, dropped } = sanitizeEnv({
      GIT_AUTHOR_NAME: 'me', // allow
      GIT_ASKPASS: '/bin/credential-dump', // deny built-in
      GIT_SSH_COMMAND: 'ssh -i /tmp/x', // deny built-in
    });
    assert.strictEqual(env.GIT_AUTHOR_NAME, 'me');
    assert.strictEqual(env.GIT_ASKPASS, undefined);
    assert.strictEqual(env.GIT_SSH_COMMAND, undefined);
    assert.ok(dropped.includes('GIT_ASKPASS'));
    assert.ok(dropped.includes('GIT_SSH_COMMAND'));
  });

  it('drops FACTORY_* vars (built-in deny prefix)', () => {
    const { env } = sanitizeEnv({
      FACTORY_DEBUG: '1',
      FACTORY_INTERNAL: 'foo',
      PATH: '/usr/bin',
    });
    assert.strictEqual(env.FACTORY_DEBUG, undefined);
    assert.strictEqual(env.FACTORY_INTERNAL, undefined);
    assert.strictEqual(env.PATH, '/usr/bin');
  });

  it('user policy can extend the allowlist', () => {
    const { env } = sanitizeEnv(
      { CUSTOM_THING: 'value', PATH: '/usr/bin' },
      { allow: ['CUSTOM_THING'] },
    );
    assert.strictEqual(env.CUSTOM_THING, 'value');
    assert.strictEqual(env.PATH, '/usr/bin');
  });

  it('user policy can extend allow-prefixes', () => {
    const { env } = sanitizeEnv(
      { MY_APP_FOO: '1', MY_APP_BAR: '2', SECRET_TOKEN: 'no' },
      { allowPrefixes: ['MY_APP_'] },
    );
    assert.strictEqual(env.MY_APP_FOO, '1');
    assert.strictEqual(env.MY_APP_BAR, '2');
    assert.strictEqual(env.SECRET_TOKEN, undefined);
  });

  it('user-added deny wins over user-added allow', () => {
    const { env } = sanitizeEnv(
      { CUSTOM_THING: 'value' },
      { allow: ['CUSTOM_THING'], deny: ['CUSTOM_THING'] },
    );
    assert.strictEqual(env.CUSTOM_THING, undefined);
  });

  it('skips undefined values silently', () => {
    const { env } = sanitizeEnv({
      PATH: '/usr/bin',
      HOME: undefined,
    });
    assert.strictEqual(env.PATH, '/usr/bin');
    assert.strictEqual(env.HOME, undefined);
  });
});
