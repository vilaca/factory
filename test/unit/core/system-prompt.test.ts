import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  buildEnvironmentMessage,
  buildSystemPrompt,
  getGitStatusSnippet,
  getLineCountHintPrompt,
  getPlanModePrompt,
  getSubagentsPrompt,
  getTextToolFallbackPrompt,
} from '../../../src/core/context/system-prompt.js';

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `oc-sysprompt-${crypto.randomUUID()}`);
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

describe('buildSystemPrompt — model tiers', () => {
  it('uses the strong-tier base prompt by default and includes strong-only guidance', async () => {
    const dir = tmpDir();
    try {
      const prompt = await buildSystemPrompt(dir);
      assert.ok(
        prompt.startsWith('You are an interactive coding assistant running in a terminal.'),
      );
      assert.ok(prompt.includes('Action over description'));
      // Strong-only line — medium and weak don't include it.
      assert.ok(prompt.includes('When running Bash commands, quote paths with spaces.'));
    } finally {
      cleanup(dir);
    }
  });

  it('uses the medium-tier base prompt when modelTier=medium', async () => {
    const dir = tmpDir();
    try {
      const prompt = await buildSystemPrompt(dir, 'medium');
      assert.ok(
        prompt.startsWith('You are an interactive coding assistant running in a terminal.'),
      );
      assert.ok(prompt.includes('Action over description'));
      // Strong-only sentence should NOT appear in medium tier.
      assert.ok(!prompt.includes('When running Bash commands, quote paths with spaces.'));
    } finally {
      cleanup(dir);
    }
  });

  it('uses the weak-tier base prompt when modelTier=weak', async () => {
    const dir = tmpDir();
    try {
      const prompt = await buildSystemPrompt(dir, 'weak');
      assert.ok(prompt.startsWith('You are a coding assistant.'));
      assert.ok(prompt.includes('Keep responses short.'));
      // Strong/medium-only sections should NOT appear.
      assert.ok(!prompt.includes('Action over description'));
      assert.ok(!prompt.includes('Anti-fabrication'));
    } finally {
      cleanup(dir);
    }
  });

  it('appends Project Instructions when CLAUDE.md exists in cwd', async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'project rule: use 4 spaces.');
      const prompt = await buildSystemPrompt(dir);
      assert.ok(prompt.includes('## Project Instructions'));
      assert.ok(prompt.includes('project rule: use 4 spaces.'));
    } finally {
      cleanup(dir);
    }
  });

  it('omits Project Instructions when no CLAUDE.md exists', async () => {
    const dir = tmpDir();
    try {
      const prompt = await buildSystemPrompt(dir);
      assert.ok(!prompt.includes('## Project Instructions'));
    } finally {
      cleanup(dir);
    }
  });

  it('appends Project Facts when package.json declares version metadata', async () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'demo', version: '1.2.3' }),
      );
      const prompt = await buildSystemPrompt(dir);
      assert.ok(prompt.includes('## Project Facts'));
      assert.ok(prompt.includes('1.2.3'));
    } finally {
      cleanup(dir);
    }
  });
});

describe('static-content prompts', () => {
  it('getPlanModePrompt describes plan mode and read-only investigation', () => {
    const text = getPlanModePrompt();
    assert.ok(text.startsWith('## PLAN MODE'));
    assert.ok(text.includes('Read, Glob, and Grep'));
    assert.ok(text.includes('Edit, Write, or Bash'));
    assert.ok(text.includes('queue'));
  });

  it('getSubagentsPrompt describes the Delegate tool and its read-only contract', () => {
    const text = getSubagentsPrompt();
    assert.ok(text.includes('Delegate'));
    assert.ok(text.includes('read-only'));
    assert.ok(text.includes('cannot edit or write'));
  });

  it('getLineCountHintPrompt mentions cloc, scc, and the wc fallback', () => {
    const text = getLineCountHintPrompt();
    assert.ok(text.includes('cloc'));
    assert.ok(text.includes('scc'));
    assert.ok(text.includes('wc -l'));
  });

  it('getTextToolFallbackPrompt describes the <tool_call> protocol and TOOL_RESULT framing', () => {
    const text = getTextToolFallbackPrompt();
    assert.ok(text.includes('<tool_call>'));
    assert.ok(text.includes('"name"'));
    assert.ok(text.includes('"arguments"'));
    assert.ok(text.includes('TOOL_RESULT'));
    assert.ok(text.includes('END_TOOL_RESULT'));
  });
});
