import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

/**
 * Resolves the gitdir for `cwd`. Treats `cwd` as the repo root — does not
 * walk upwards. Returns `undefined` when there's no `.git` at this level
 * (running from a subdirectory is the user's problem). Throws on unexpected
 * fs errors so callers can warn rather than silently dropping git context.
 */
async function resolveGitDir(cwd: string): Promise<string | undefined> {
  const dotGit = path.join(cwd, '.git');
  let st;
  try {
    st = await fs.stat(dotGit);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  if (st.isDirectory()) return dotGit;
  if (st.isFile()) {
    // Linked worktree: .git is a file containing `gitdir: <path>`.
    const contents = await fs.readFile(dotGit, 'utf8');
    const match = contents.match(/^gitdir:\s*(.+)$/m);
    if (!match) throw new Error(`malformed worktree pointer: ${dotGit}`);
    return path.resolve(cwd, match[1]!.trim());
  }
  return undefined;
}

export async function getGitBranch(cwd: string): Promise<string | undefined> {
  const gitDir = await resolveGitDir(cwd);
  if (!gitDir) return undefined;
  const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
  const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  return ref ? ref[1] : 'HEAD';
}

/** Cap `git status` so a hanging/locked repo doesn't block startup or the
 *  per-turn refresh. Local `git status` returns in <100ms for sane working
 *  trees; >2s means something is wrong (network filesystem stall, long
 *  hook, index lock contention) and we'd rather show no git state than
 *  freeze the UI. */
const GIT_STATUS_TIMEOUT_MS = 2_000;
/** Bound on porcelain output. Dense format, but a very dirty tree (or a
 *  rogue `git status -s -uall`) could push past Node's default 1 MiB. */
const GIT_STATUS_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Returns whether the working tree has uncommitted changes, or `null` when
 * `cwd` is not a git repo root. Throws on unexpected fs/git failures
 * (permission errors, missing `git` binary, timeout) — callers should warn
 * rather than silently dropping the Git section.
 */
export async function isGitDirty(cwd: string): Promise<boolean | null> {
  if (!(await isGitRepo(cwd))) return null;
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
    cwd,
    timeout: GIT_STATUS_TIMEOUT_MS,
    maxBuffer: GIT_STATUS_MAX_BUFFER,
  });
  return stdout.trim().length > 0;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return (await resolveGitDir(cwd)) !== undefined;
}
