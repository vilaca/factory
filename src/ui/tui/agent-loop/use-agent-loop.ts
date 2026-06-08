import type { AgentLoopApi, UseAgentLoopOptions } from './agent-loop-types.js';
import { useAgentLoopState } from './useAgentLoopState.js';
import { useAgentLoopSession } from './useAgentLoopSession.js';
import { useAgentLoopActions } from './useAgentLoopActions.js';

export type { AgentLoopApi };

export function useAgentLoop(opts: UseAgentLoopOptions): AgentLoopApi {
  const state = useAgentLoopState(opts);
  useAgentLoopSession(opts, state);
  const actions = useAgentLoopActions(opts, state);

  return {
    items: state.items,
    state: state.state,
    thinking: state.thinking,
    compacting: state.compacting,
    runningTool: state.runningTool,
    activity: state.activity,
    streamingText: state.streamingText,
    permissionRequest: state.permissionRequest,
    pendingToolCall: state.pendingToolCall,
    plannedCalls: state.plannedCalls,
    planMode: state.planMode,
    providerName: state.providerName,
    model: state.model,
    sessionTurns: state.sessionTurns,
    sessionToolCalls: state.sessionToolCalls,
    lastUsage: state.lastUsage,
    estimatedTokens: state.estimatedTokens,
    contextWindow: state.contextWindow,
    queueLength: state.queueLength,
    gitBranch: state.gitBranch,
    gitDirty: state.gitDirty,
    cwd: state.cwd,
    emojiMode: state.emojiMode,
    userEmoji: state.userEmoji,
    refs: state.refs,
    submitPrompt: actions.submitPrompt,
    queueInput: actions.queueInput,
    respondToPermission: actions.respondToPermission,
    abort: actions.abort,
    clearConversation: actions.clearConversation,
    setModelByName: actions.setModelByName,
    togglePlanMode: actions.togglePlanMode,
    setCorrector: actions.setCorrector,
    setExperimentalFlag: actions.setExperimentalFlag,
    approvePlan: actions.approvePlan,
    cancelPlan: actions.cancelPlan,
    resetPermissions: actions.resetPermissions,
    setCwd: actions.setCwd,
    setProviderByName: actions.setProviderByName,
    recordHistory: actions.recordHistory,
    historyUp: actions.historyUp,
    historyDown: actions.historyDown,
    addNotice: state.addNotice,
    addNoticeBlock: state.addNoticeBlock,
    addNoticeBox: state.addNoticeBox,
    setIdle: actions.setIdle,
    toggleEmojiMode: actions.toggleEmojiMode,
    setUserEmoji: actions.setUserEmoji,
    getRunState: actions.getRunState,
  };
}
