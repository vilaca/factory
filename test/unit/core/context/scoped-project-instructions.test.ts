import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createScopedProjectInstructionsState,
  refreshScopedProjectInstructionsFromToolCall,
} from '../../../../src/core/context/scoped-project-instructions.js';

describe('refreshScopedProjectInstructionsFromToolCall', () => {
  it('loads scoped instructions after a successful Bash call in cwd', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-scoped-bash-'));
    try {
      await fs.writeFile(path.join(root, 'AGENTS.md'), 'root-guidance');

      const state = createScopedProjectInstructionsState(root);
      const event = {
        toolName: 'Bash',
        args: { command: 'git status' },
      } as const;

      const refreshed = await refreshScopedProjectInstructionsFromToolCall(state, event, root);
      assert.equal(refreshed.changed, true);
      assert.match(state.scopedInstructions ?? '', /root-guidance/);
      assert.deepEqual(refreshed.newFiles, [path.join(root, 'AGENTS.md')]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('loads instructions even when the tool call ultimately fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-scoped-fail-'));
    try {
      await fs.writeFile(path.join(root, 'AGENTS.md'), 'root-guidance');

      const state = createScopedProjectInstructionsState(root);
      const event = {
        toolName: 'Read',
        args: { file_path: 'missing.txt' },
      } as const;

      const refreshed = await refreshScopedProjectInstructionsFromToolCall(state, event, root);
      assert.equal(refreshed.changed, true);
      assert.match(state.scopedInstructions ?? '', /root-guidance/);
      assert.deepEqual(refreshed.newFiles, [path.join(root, 'AGENTS.md')]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('loads child directory instructions before parent (deepest first)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-scoped-depth-'));
    try {
      await fs.mkdir(path.join(root, 'src', 'ui', 'tui', 'agent-loop'), { recursive: true });
      await fs.writeFile(path.join(root, 'AGENTS.md'), 'root-guidance');
      await fs.writeFile(path.join(root, 'src', 'ui', 'tui', 'agent-loop', 'AGENTS.md'), 'specific-guidance');

      const state = createScopedProjectInstructionsState(root);
      const event = {
        toolName: 'Read',
        args: { file_path: path.join('src', 'ui', 'tui', 'agent-loop', 'somefile.ts') },
      } as const;

      const refreshed = await refreshScopedProjectInstructionsFromToolCall(state, event, root);
      assert.equal(refreshed.changed, true);

      const instructions = state.scopedInstructions ?? '';
      const specificIdx = instructions.indexOf('specific-guidance');
      const rootIdx = instructions.indexOf('root-guidance');
      assert.ok(specificIdx !== -1, 'specific-guidance should be present');
      assert.ok(rootIdx !== -1, 'root-guidance should be present');
      assert.ok(specificIdx < rootIdx, 'deeper (child) instructions should appear before shallower (root) ones');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('includes all instruction files without a byte cap', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-scoped-nocap-'));
    try {
      await fs.mkdir(path.join(root, 'deep', 'a', 'b', 'c'), { recursive: true });
      // Write many large-ish instruction files to exceed any old 16 KiB cap
      const bigContent = 'x'.repeat(4096);
      await fs.writeFile(path.join(root, 'AGENTS.md'), `root ${bigContent}`);
      await fs.writeFile(path.join(root, 'deep', 'AGENTS.md'), `deep ${bigContent}`);
      await fs.writeFile(path.join(root, 'deep', 'a', 'AGENTS.md'), `deeper ${bigContent}`);
      await fs.writeFile(path.join(root, 'deep', 'a', 'b', 'AGENTS.md'), `deepest ${bigContent}`);

      const state = createScopedProjectInstructionsState(root);
      const event = {
        toolName: 'Read',
        args: { file_path: path.join('deep', 'a', 'b', 'file.ts') },
      } as const;

      const refreshed = await refreshScopedProjectInstructionsFromToolCall(state, event, root);
      assert.equal(refreshed.changed, true);

      const instructions = state.scopedInstructions ?? '';
      assert.ok(instructions.includes('root'), 'root AGENTS.md should be included');
      assert.ok(instructions.includes('deep'), 'deep AGENTS.md should be included');
      assert.ok(instructions.includes('deeper'), 'deeper AGENTS.md should be included');
      assert.ok(instructions.includes('deepest'), 'deepest AGENTS.md should be included');
      assert.ok(!instructions.includes('truncated'), 'no truncation notice should appear');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reloads scoped instructions for already-touched directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-scoped-refresh-'));
    try {
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      await fs.writeFile(path.join(root, 'AGENTS.md'), 'version-one');
      await fs.writeFile(path.join(root, 'src', 'file.txt'), 'hello');

      const state = createScopedProjectInstructionsState(root);
      const event = {
        toolName: 'Read',
        args: { file_path: 'src/file.txt' },
      } as const;

      const first = await refreshScopedProjectInstructionsFromToolCall(state, event, root);
      assert.equal(first.changed, true);
      assert.match(state.scopedInstructions ?? '', /version-one/);

      await fs.writeFile(path.join(root, 'AGENTS.md'), 'version-two');
      const second = await refreshScopedProjectInstructionsFromToolCall(state, event, root);
      assert.equal(second.changed, true);
      assert.match(state.scopedInstructions ?? '', /version-two/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
