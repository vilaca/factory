import { useEffect } from 'react';
import { mountSession } from './setup.js';
import type { UseAgentLoopOptions } from './agent-loop-types.js';
import type { AgentLoopStateStore } from './useAgentLoopState.js';

/** One-shot session mount lifecycle (session logger, refs, skills, hooks). */
export function useAgentLoopSession(opts: UseAgentLoopOptions, state: AgentLoopStateStore): void {
  useEffect(() => {
    return mountSession(opts, {
      refs: state.refs,
      addNotice: state.addNotice,
      setEstimatedTokens: state.setEstimatedTokens,
      setContextWindow: state.setContextWindow,
      setCwdState: state.setCwdState,
      composeSystemPrompt: state.composeSystemPrompt,
    });
  }, []);
}
