import chalk from 'chalk';
import type { McpManager } from '../../mcp/client.js';
import { getGitBranch, isGitDirty } from '../../utils/git.js';
import { errorMessage } from '../../utils/errors.js';
import { withBoundedTimeout } from '../../utils/timeout.js';

export interface ShutdownHandlerOptions {
  /** Returns the live MCP manager (or undefined if MCP isn't configured).
   *  Callable so the closure picks up changes after install — e.g. when
   *  MCP setup completes after the handler is wired. */
  getMcpManager: () => McpManager | undefined;
  budgetMs: number;
}

/**
 * Install SIGINT and SIGTERM handlers that run a bounded cleanup race —
 * disconnects MCP, flushes per-key stats, and forces exit if cleanup
 * exceeds the wall-clock budget. Used to prevent a hung MCP `close()`
 * from blocking process termination.
 */
export function installShutdownHandlers(opts: ShutdownHandlerOptions): void {
  const cleanup = async (): Promise<void> => {
    const pending: string[] = [];
    const mcpManager = opts.getMcpManager();
    if (mcpManager) {
      const { pending: stuck } = await mcpManager.disconnect().catch(() => ({ pending: [] }));
      for (const name of stuck) pending.push(`mcp:${name}`);
    }
    const flushDone = (async () => {
      const { flushKeyStats } = await import('../../core/session/key-stats.js');
      await flushKeyStats();
    })().catch(() => {
      pending.push('key-stats');
    });
    await flushDone;
    if (pending.length > 0) {
      process.stderr.write(`shutdown: ${pending.join(', ')} did not finish in time\n`);
    }
  };
  const boundedCleanup = (): Promise<void> =>
    withBoundedTimeout(cleanup, opts.budgetMs, () => {
      process.stderr.write(`shutdown: cleanup exceeded ${opts.budgetMs}ms, forcing exit\n`);
    }).then(() => undefined);
  process.on('SIGINT', () => {
    void boundedCleanup().finally(() => process.exit(130));
  });
  process.on('SIGTERM', () => {
    void boundedCleanup().finally(() => process.exit(0));
  });
}

export interface GitState {
  gitBranch?: string;
  gitDirty: boolean | null;
}

/**
 * Resolve git branch + dirty status in parallel, surfacing soft warnings
 * (yellow ⚠ chalk text) on either failure rather than aborting the
 * launch. A repo without git or with permission issues still launches.
 */
export async function gatherGitState(cwd: string): Promise<GitState> {
  let gitBranch: string | undefined;
  let gitDirty: boolean | null = null;
  const [branchRes, dirtyRes] = await Promise.allSettled([getGitBranch(cwd), isGitDirty(cwd)]);
  if (branchRes.status === 'fulfilled') {
    gitBranch = branchRes.value;
  } else {
    console.log(chalk.yellow(`  ⚠ Could not read git branch: ${errorMessage(branchRes.reason)}`));
  }
  if (dirtyRes.status === 'fulfilled') {
    gitDirty = dirtyRes.value;
  } else {
    console.log(
      chalk.yellow(`  ⚠ Could not check git dirty state: ${errorMessage(dirtyRes.reason)}`),
    );
  }
  return { ...(gitBranch !== undefined ? { gitBranch } : {}), gitDirty };
}
