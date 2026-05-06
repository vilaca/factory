import { describe, it } from 'node:test';
import assert from 'node:assert';
import os from 'os';
import {
  buildEnvironmentMessage,
  buildSystemPrompt,
  getGitStatusSnippet,
} from '../../src/core/system-prompt.js';

describe('getGitStatusSnippet', () => {
  it('returns an empty string when dirty is null (not a repo)', () => {
    assert.strictEqual(getGitStatusSnippet(null), '');
  });

  it("renders 'clean' when dirty is false", () => {
    assert.strictEqual(getGitStatusSnippet(false), '## Git\n- Status: clean');
  });

  it("renders 'dirty' when dirty is true", () => {
    assert.strictEqual(getGitStatusSnippet(true), '## Git\n- Status: dirty');
  });
});

describe('buildSystemPrompt — stable prefix', () => {
  it('does not embed cwd, platform, or shell in the system prompt', async () => {
    const cwd = os.tmpdir();
    const prompt = await buildSystemPrompt(cwd, 'strong');
    // cwd, platform, and SHELL used to live in a `## Environment` section
    // here; they're now in buildEnvironmentMessage so the prompt bytes are
    // stable across turns.
    assert.ok(!prompt.includes(cwd), `system prompt unexpectedly contains cwd: ${cwd}`);
    assert.ok(!prompt.includes(`Platform: ${os.platform()}`), 'system prompt contains platform');
    assert.ok(!prompt.includes('Shell:'), 'system prompt contains shell label');
    assert.ok(!prompt.includes('## Environment'), 'system prompt still has Environment section');
  });

  it('produces byte-identical output across calls (no time-based volatility)', async () => {
    const cwd = os.tmpdir();
    const a = await buildSystemPrompt(cwd, 'strong');
    const b = await buildSystemPrompt(cwd, 'strong');
    assert.strictEqual(a, b, 'system prompt should be byte-stable across calls');
  });
});

describe('buildEnvironmentMessage', () => {
  it('renders cwd, platform, and shell as a Markdown section', () => {
    const msg = buildEnvironmentMessage('/some/path');
    assert.ok(msg.startsWith('## Environment'));
    assert.ok(msg.includes('Working directory: /some/path'));
    assert.ok(msg.includes(`Platform: ${os.platform()}`));
    assert.ok(msg.includes('Shell:'));
  });

  it('falls back to "bash" when SHELL is unset', () => {
    const prevShell = process.env.SHELL;
    delete process.env.SHELL;
    try {
      const msg = buildEnvironmentMessage('/x');
      assert.ok(msg.includes('Shell: bash'));
    } finally {
      if (prevShell !== undefined) process.env.SHELL = prevShell;
    }
  });
});
