import { getGitBranch, isGitDirty } from '../../../utils/git.js';
import type { AgentLoopDeps } from './types.js';

export async function refreshGitState(
  deps: AgentLoopDeps,
  setGitBranch: (b: string | undefined) => void,
  setGitDirtyState: (d: boolean | null) => void,
): Promise<void> {
  if (!deps.refs.current) return;
  const cwd = deps.refs.current.cwd;
  try {
    const [branch, dirty] = await Promise.all([getGitBranch(cwd), isGitDirty(cwd)]);
    const prevBranch = deps.refs.current.gitBranch;
    const prevDirty = deps.refs.current.gitDirty;
    if (branch === prevBranch && dirty === prevDirty) return;
    deps.refs.current.gitBranch = branch;
    deps.refs.current.gitDirty = dirty;
    if (branch !== prevBranch) setGitBranch(branch);
    if (dirty !== prevDirty) {
      setGitDirtyState(dirty);
      deps.refs.current.conversation.updateSystemPrompt(deps.composeSystemPrompt());
      deps.refreshTokenEstimate();
    }
    deps.refs.current.sessionLogger?.logGitChange(
      { branch: prevBranch, dirty: prevDirty },
      { branch, dirty },
    );
  } catch (err) {
    deps.addNotice('warn', `⚠ Could not refresh git state: ${(err as Error).message}`);
    deps.refs.current.sessionLogger?.logWarning('git-refresh', (err as Error).message);
  }
}
