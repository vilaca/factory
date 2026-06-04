import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAgentLoopInternal, processInput } from './run-loop.js';
import { refreshGitState } from './git-state.js';
import {
  recordHistory as recordHistoryPure,
  historyUp as historyUpPure,
  historyDown as historyDownPure,
} from './history.js';
import { errorMessage } from '../../../utils/errors.js';
import { swapModel, swapProvider } from './swap.js';
import type { ExperimentalFlags } from '../../../core/config/types.js';
import type {
  AgentLoopApi,
  AgentLoopDeps,
  PermissionDecision,
  UseAgentLoopOptions,
} from './agent-loop-types.js';
import type { AgentLoopStateStore } from './useAgentLoopState.js';

interface BuildDepsContext {
  opts: UseAgentLoopOptions;
  state: AgentLoopStateStore;
}

function buildDeps({ opts, state }: BuildDepsContext): AgentLoopDeps {
  return {
    refs: state.refs,
    agentConfig: opts.agentConfig,
    addItem: state.addItem,
    addNotice: state.addNotice,
    nextId: state.nextId,
    refreshTokenEstimate: state.refreshTokenEstimate,
    composeSystemPrompt: state.composeSystemPrompt,
    setState: state.setState,
    setThinking: state.setThinking,
    setRunningTool: state.setRunningTool,
    setActivity: state.setActivity,
    setStreamingText: state.setStreamingText,
    setCompacting: state.setCompacting,
    setSessionTurns: state.setSessionTurns,
    setSessionToolCalls: state.setSessionToolCalls,
    setLastUsage: state.setLastUsage,
    setPermissionRequest: state.setPermissionRequest,
    setPendingToolCall: state.setPendingToolCall,
    setPlannedCalls: state.setPlannedCalls,
    getPlannedCalls: () => state.plannedCalls,
  };
}

export function useAgentLoopActions(
  opts: UseAgentLoopOptions,
  state: AgentLoopStateStore,
): Pick<
  AgentLoopApi,
  | 'submitPrompt'
  | 'queueInput'
  | 'respondToPermission'
  | 'abort'
  | 'clearConversation'
  | 'setModelByName'
  | 'togglePlanMode'
  | 'setCorrector'
  | 'setExperimentalFlag'
  | 'approvePlan'
  | 'cancelPlan'
  | 'resetPermissions'
  | 'setCwd'
  | 'setProviderByName'
  | 'recordHistory'
  | 'historyUp'
  | 'historyDown'
  | 'setIdle'
  | 'toggleEmojiMode'
  | 'setUserEmoji'
  | 'getRunState'
> {
  async function submitPrompt(initial: string): Promise<void> {
    const deps = buildDeps({ opts, state });
    let next: string | undefined = initial;
    while (next !== undefined && state.refs.current) {
      try {
        await processInput(next, deps);
      } catch (err) {
        state.addNotice('danger', `Error: ${errorMessage(err)}`);
      }
      next = state.refs.current.inputQueue.shift();
      state.setQueueLength(state.refs.current.inputQueue.length);
      if (next !== undefined) {
        state.addNotice(
          'info',
          `📨 processing queued: ${next.slice(0, 80)}${next.length > 80 ? '…' : ''}`,
        );
      }
    }
    state.setState('idle');
    if (state.refs.current && state.refs.current.cwd !== state.cwd) {
      state.setCwdState(state.refs.current.cwd);
    }
    void refreshGitState(deps, state.setGitBranch, state.setGitDirtyState);
  }

  function queueInput(text: string): void {
    if (!state.refs.current) return;
    state.refs.current.inputQueue.push(text);
    state.setQueueLength(state.refs.current.inputQueue.length);
    state.addNotice(
      'info',
      `📨 queued (${state.refs.current.inputQueue.length} pending) — runs after current task.`,
    );
  }

  function respondToPermission(decision: PermissionDecision): void {
    state.permissionRequest?.resolve(decision);
    state.setPermissionRequest(undefined);
  }

  function abort(): void {
    state.refs.current?.abort?.abort();
  }

  function clearConversation(): void {
    if (!state.refs.current) return;
    state.refs.current.conversation.clear();
    state.refs.current.responsesChain = undefined;
    state.setItems([]);
    state.setStreamingText('');
    state.setLastUsage(undefined);
    state.setSessionTurns(() => 0);
    state.setSessionToolCalls(() => 0);
    state.setEstimatedTokens(undefined);
    state.refs.current.contextManager.recordPromptUsage(undefined);
    state.refs.current.contextManager.resetThresholds();
    const fallbackWasAutoFlipped =
      state.refs.current.useTextToolFallback && state.refs.current.nativeToolSupport;
    state.refs.current.useTextToolFallback = !state.refs.current.nativeToolSupport;
    state.refs.current.conversation.updateSystemPrompt(state.composeSystemPrompt());
    state.refreshTokenEstimate();
    state.addNotice('info', 'Conversation cleared.');
    if (fallbackWasAutoFlipped) {
      state.addNotice('info', 'Text-tool fallback reset; back to native tool calls.');
    }
  }

  function buildSwapCtx(): Parameters<typeof swapModel>[1] {
    return {
      refs: state.refs,
      opts,
      addNotice: state.addNotice,
      setModel: state.setModel,
      setProviderName: state.setProviderName,
      setContextWindow: state.setContextWindow,
      refreshTokenEstimate: state.refreshTokenEstimate,
      composeSystemPrompt: state.composeSystemPrompt,
    };
  }

  async function setModelByName(name: string): Promise<void> {
    await swapModel(name, buildSwapCtx());
  }

  async function setProviderByName(name: string, requestedModel?: string, keyId?: string): Promise<void> {
    await swapProvider(name, requestedModel, keyId, buildSwapCtx());
  }

  function togglePlanMode(): void {
    if (!state.refs.current) return;
    state.refs.current.planMode = !state.refs.current.planMode;
    state.setPlanMode(state.refs.current.planMode);
    const sp = state.composeSystemPrompt();
    state.refs.current.conversation.updateSystemPrompt(sp);
    state.refs.current.sessionLogger?.logSystemPromptChange(`plan-mode=${state.refs.current.planMode}`);
    state.refs.current.sessionLogger?.logSystemPrompt(sp);
    state.addNotice('cyan', `Plan mode: ${state.refs.current.planMode ? 'ON' : 'OFF'}.`);
  }

  function setCorrector(value: boolean): void {
    if (!state.refs.current) return;
    state.refs.current.enableCorrector = value;
    state.addNotice('info', `LLM tool-call corrector: ${value ? 'ON' : 'OFF'}.`);
  }

  function toggleEmojiMode(): void {
    state.setEmojiMode(prev => {
      const next = !prev;
      state.addNotice('info', `Emoji mode: ${next ? 'ON 🤖' : 'OFF'}.`);
      return next;
    });
  }

  function setUserEmoji(emoji: string): void {
    const trimmed = emoji.trim();
    if (!trimmed) {
      state.addNotice('warn', 'Usage: /emoji <emoji>  (no arg toggles on/off)');
      return;
    }
    state.setUserEmojiState(trimmed);
    state.setEmojiMode(true);
    state.addNotice('info', `User emoji: ${trimmed} (emoji mode ON).`);
  }

  function setExperimentalFlag(name: keyof ExperimentalFlags, value: boolean): void {
    if (!state.refs.current) return;
    state.refs.current.experimental = { ...state.refs.current.experimental, [name]: value };
    if (name === 'lineCountHint' || name === 'subagents') {
      const sp = state.composeSystemPrompt();
      state.refs.current.conversation.updateSystemPrompt(sp);
      state.refs.current.sessionLogger?.logSystemPromptChange(`${name}=${value}`);
      state.refs.current.sessionLogger?.logSystemPrompt(sp);
    }
    state.addNotice('info', `Experimental ${name}: ${value ? 'on' : 'off'}.`);
  }

  async function approvePlan(): Promise<void> {
    if (!state.refs.current) return;
    const plan = state.plannedCalls;
    state.setPlannedCalls([]);
    state.refs.current.planMode = false;
    state.setPlanMode(false);
    const sp = state.composeSystemPrompt();
    state.refs.current.conversation.updateSystemPrompt(sp);
    state.refs.current.sessionLogger?.logSystemPromptChange('plan-mode=false');
    state.refs.current.sessionLogger?.logSystemPrompt(sp);
    state.addNotice('cyan', `Executing ${plan.length} planned tool call${plan.length === 1 ? '' : 's'}...`);
    const summary = plan.map(p => `- ${p.toolName}: ${JSON.stringify(p.args).slice(0, 200)}`).join('\n');
    state.setState('running');
    try {
      await runAgentLoopInternal(
        `Execute the plan you proposed:\n${summary}\n\nIssue each tool call now.`,
        buildDeps({ opts, state }),
      );
    } finally {
      state.setState('idle');
    }
  }

  function cancelPlan(): void {
    state.setPlannedCalls([]);
  }

  function resetPermissions(): void {
    state.refs.current?.permissions.reset();
    state.refs.current?.sessionLogger?.logPermissionChange('reset');
  }

  function setCwd(target: string): void {
    if (!state.refs.current) return;
    const trimmed = target.trim();
    if (!trimmed) {
      state.addNotice('info', `cwd: ${state.refs.current.cwd}`);
      return;
    }
    let resolved = trimmed;
    if (resolved.startsWith('~')) resolved = os.homedir() + resolved.slice(1);
    resolved = path.resolve(state.refs.current.cwd, resolved);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        state.addNotice('warn', `cwd: ${resolved} is not a directory.`);
        return;
      }
    } catch (err) {
      state.addNotice('warn', `cwd: ${resolved} — ${errorMessage(err)}`);
      return;
    }
    state.refs.current.cwd = resolved;
    state.setCwdState(resolved);
    state.addNotice('info', `📁 cwd → ${resolved}`);
  }

  function recordHistory(text: string): void {
    recordHistoryPure(state.refs, text);
  }

  function historyUp(currentInput: string): string | null {
    return historyUpPure(state.refs, currentInput);
  }

  function historyDown(): string | null {
    return historyDownPure(state.refs);
  }

  function setIdle(): void {
    state.setState('idle');
  }

  function getRunState() {
    return state.state;
  }

  return {
    submitPrompt,
    queueInput,
    respondToPermission,
    abort,
    clearConversation,
    setModelByName,
    togglePlanMode,
    setCorrector,
    setExperimentalFlag,
    approvePlan,
    cancelPlan,
    resetPermissions,
    setCwd,
    setProviderByName,
    recordHistory,
    historyUp,
    historyDown,
    setIdle,
    toggleEmojiMode,
    setUserEmoji,
    getRunState,
  };
}
