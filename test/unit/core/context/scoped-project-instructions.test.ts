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
  it('discovers scoped instruction files after a successful Bash call in cwd', async () => {
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
      assert.equal(state.scopedInstructions, null);
      assert.deepEqual(refreshed.newFiles, [path.join(root, 'AGENTS.md')]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('discovers instructions even when the tool call ultimately fails', async () => {
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
      assert.equal(state.scopedInstructions, null);
      assert.deepEqual(refreshed.newFiles, [path.join(root, 'AGENTS.md')]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('discovers child directory instructions before parent (deepest first)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-scoped-depth-'));
    try {
      await fs.mkdir(path.join(root, 'src', 'ui', 'tui', 'agent-loop'), { recursive: true });
      await fs.writeFile(path.join(root, 'AGENTS.md'), 'root-guidance');
      await fs.writeFile(
        path.join(root, 'src', 'ui', 'tui', 'agent-loop', 'AGENTS.md'),
        'specific-guidance',
      );

      const state = createScopedProjectInstructionsState(root);
      const event = {
        toolName: 'Read',
        args: { file_path: path.join('src', 'ui', 'tui', 'agent-loop', 'somefile.ts') },
      } as const;

      const refreshed = await refreshScopedProjectInstructionsFromToolCall(state, event, root);
      assert.equal(refreshed.changed, true);
      assert.deepEqual(refreshed.newFiles, [
        path.join(root, 'src', 'ui', 'tui', 'agent-loop', 'AGENTS.md'),
        path.join(root, 'AGENTS.md'),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('discovers all instruction files without a byte cap', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-scoped-nocap-'));
    try {
      await fs.mkdir(path.join(root, 'deep', 'a', 'b', 'c'), { recursive: true });
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
      assert.deepEqual(refreshed.newFiles, [
        path.join(root, 'deep', 'a', 'b', 'AGENTS.md'),
        path.join(root, 'deep', 'a', 'AGENTS.md'),
        path.join(root, 'deep', 'AGENTS.md'),
        path.join(root, 'AGENTS.md'),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not re-report unchanged discovered instruction files', async () => {
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
      assert.deepEqual(first.newFiles, [path.join(root, 'AGENTS.md')]);

      const second = await refreshScopedProjectInstructionsFromToolCall(state, event, root);
      assert.equal(second.changed, false);
      assert.deepEqual(second.newFiles, []);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
