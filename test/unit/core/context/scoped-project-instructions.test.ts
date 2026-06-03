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
        result: { success: true },
      } as const;

      const refreshed = await refreshScopedProjectInstructionsFromToolCall(state, event, root);
      assert.equal(refreshed.changed, true);
      assert.match(state.scopedInstructions ?? '', /root-guidance/);
      assert.deepEqual(refreshed.newFiles, [path.join(root, 'AGENTS.md')]);
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
        result: { success: true },
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
