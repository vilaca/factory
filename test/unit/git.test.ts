import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { getGitBranch, isGitRepo } from '../../src/utils/git.js';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-git-'));
  try {
    await fn(await fs.realpath(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function makeRepo(dir: string, headContents: string): Promise<void> {
  const gitDir = path.join(dir, '.git');
  await fs.mkdir(gitDir, { recursive: true });
  await fs.writeFile(path.join(gitDir, 'HEAD'), headContents);
}

describe('getGitBranch', () => {
  it('returns the branch name from .git/HEAD', async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir, 'ref: refs/heads/main\n');
      assert.strictEqual(await getGitBranch(dir), 'main');
    });
  });

  it('handles slashes in branch names', async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir, 'ref: refs/heads/feat/something-cool\n');
      assert.strictEqual(await getGitBranch(dir), 'feat/something-cool');
    });
  });

  it("returns 'HEAD' when detached", async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir, '0123456789abcdef0123456789abcdef01234567\n');
      assert.strictEqual(await getGitBranch(dir), 'HEAD');
    });
  });

  it('returns undefined from a subdirectory (does not walk up)', async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir, 'ref: refs/heads/main\n');
      const sub = path.join(dir, 'src', 'nested');
      await fs.mkdir(sub, { recursive: true });
      assert.strictEqual(await getGitBranch(sub), undefined);
    });
  });

  it('returns undefined when not in a repo', async () => {
    await withTempDir(async (dir) => {
      assert.strictEqual(await getGitBranch(dir), undefined);
    });
  });

  it('resolves linked-worktree .git pointer files', async () => {
    await withTempDir(async (root) => {
      const mainGit = path.join(root, 'main', '.git');
      const worktreeGit = path.join(root, 'main', '.git', 'worktrees', 'wt');
      await fs.mkdir(mainGit, { recursive: true });
      await fs.mkdir(worktreeGit, { recursive: true });
      await fs.writeFile(path.join(worktreeGit, 'HEAD'), 'ref: refs/heads/feature\n');

      const wt = path.join(root, 'wt');
      await fs.mkdir(wt);
      await fs.writeFile(path.join(wt, '.git'), `gitdir: ${worktreeGit}\n`);

      assert.strictEqual(await getGitBranch(wt), 'feature');
    });
  });

  it('throws on a malformed worktree pointer', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, '.git'), 'this is not a gitdir pointer\n');
      await assert.rejects(getGitBranch(dir), /malformed worktree pointer/);
    });
  });

  it('throws when HEAD is missing in an otherwise valid .git', async () => {
    await withTempDir(async (dir) => {
      await fs.mkdir(path.join(dir, '.git'));
      await assert.rejects(getGitBranch(dir), /ENOENT/);
    });
  });
});

describe('isGitRepo', () => {
  it('returns true for a directory containing .git', async () => {
    await withTempDir(async (dir) => {
      await makeRepo(dir, 'ref: refs/heads/main\n');
      assert.strictEqual(await isGitRepo(dir), true);
    });
  });

  it('returns false for a non-repo directory', async () => {
    await withTempDir(async (dir) => {
      assert.strictEqual(await isGitRepo(dir), false);
    });
  });
});
