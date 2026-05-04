import { useState, useEffect, useRef, useCallback } from 'react';
import { ContextManager } from '../../core/context-manager.js';
import { validateModelToolSupport } from '../../core/model-validation.js';
import type { ExperimentalFlags } from '../../core/config-types.js';
import type { DisplayItem, ToolCallSummary } from './types.js';
import { composeSystemPrompt as composeSystemPromptPure } from './agent-loop/system-prompt.js';
import {
  startSessionLogger,
  createInitialRefs,
  loadInitialHistory,
} from './agent-loop/init.js';
import { runAgentLoopInternal, processInput } from './agent-loop/run-loop.js';
import { refreshGitState } from './agent-loop/git-state.js';
import {
  recordHistory as recordHistoryPure,
  historyUp as historyUpPure,
  historyDown as historyDownPure,
} from './agent-loop/history.js';
import type {
  AgentLoopApi,
  AgentLoopDeps,
  NoticeLevel,
  PermissionDecision,
  PermissionRequestState,
  RunRefs,
  RunState,
  UseAgentLoopOptions,
} from './agent-loop/types.js';

export type {
  AgentLoopApi,
  NoticeLevel,
  PermissionDecision,
  PermissionRequestState,
  RunRefs,
  RunState,
  UseAgentLoopOptions,
};

export function useAgentLoop(opts: UseAgentLoopOptions): AgentLoopApi {
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [state, setState] = useState<RunState>('idle');
  const [plannedCalls, setPlannedCalls] = useState<ToolCallSummary[]>([]);
  const [planMode, setPlanMode] = useState(opts.planMode ?? false);
  const [model, setModel] = useState(opts.model);
  const [sessionTurns, setSessionTurns] = useState(0);
  const [sessionToolCalls, setSessionToolCalls] = useState(0);
  const [lastUsage, setLastUsage] = useState<{ totalTokens?: number } | undefined>();
  const [estimatedTokens, setEstimatedTokens] = useState<number | undefined>();
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequestState | undefined>();
  const [pendingToolCall, setPendingToolCall] = useState<ToolCallSummary | null>(null);
  const [queueLength, setQueueLength] = useState(0);
  const [thinking, setThinking] = useState(false);
  const [compacting, setCompacting] = useState<{ aggressive: boolean } | null>(null);
  const [runningTool, setRunningTool] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [gitBranch, setGitBranch] = useState<string | undefined>(opts.gitBranch);
  const [gitDirty, setGitDirtyState] = useState<boolean | null>(opts.gitDirty ?? null);

  const idCounter = useRef(0);
  const nextId = useCallback(() => ++idCounter.current, []);
  const refs = useRef<RunRefs | null>(null);

  function addItem(item: DisplayItem): void {
    setItems((prev) => [...prev, item]);
  }
  function addNotice(level: NoticeLevel, text: string): void {
    addItem({ kind: 'notice', id: nextId(), text, level });
  }
  function addNoticeBlock(lines: { level: NoticeLevel; text: string }[]): void {
    addItem({ kind: 'notice-block', id: nextId(), lines });
  }
  function refreshTokenEstimate(): void {
    if (!refs.current) return;
    refs.current.contextManager.updateUsage(undefined);
    setEstimatedTokens(refs.current.contextManager.getTokenEstimate());
  }

  function composeSystemPrompt(): string {
    if (!refs.current) return '';
    return composeSystemPromptPure({
      baseSystemPrompt: refs.current.baseSystemPrompt,
      useTextToolFallback: refs.current.useTextToolFallback,
      planMode: refs.current.planMode,
      lineCountHint: refs.current.experimental.lineCountHint ?? false,
      gitDirty: refs.current.gitDirty,
    });
  }

  // One-shot initialization
  useEffect(() => {
    const sessionLogger = startSessionLogger(opts, addNotice);

    const baseSystemPrompt = opts.systemPrompt;
    const useTextToolFallback = opts.useTextToolFallback ?? false;
    const initialPlanMode = opts.planMode ?? false;
    const initialExperimental: ExperimentalFlags = { ...(opts.agentConfig?.experimental ?? {}) };
    const initialGitDirty = opts.gitDirty ?? null;

    const initialSystemPrompt = composeSystemPromptPure({
      baseSystemPrompt,
      useTextToolFallback,
      planMode: initialPlanMode,
      lineCountHint: initialExperimental.lineCountHint ?? false,
      gitDirty: initialGitDirty,
    });

    refs.current = createInitialRefs({
      opts,
      sessionLogger,
      initialSystemPrompt,
      baseSystemPrompt,
      useTextToolFallback,
      initialPlanMode,
      initialExperimental,
      initialGitDirty,
    });

    // Seed the token estimate so the status bar shows the system prompt's
    // baseline before the first model response.
    refs.current.contextManager.updateUsage(undefined);
    setEstimatedTokens(refs.current.contextManager.getTokenEstimate());

    if (sessionLogger) {
      sessionLogger.logSystemPrompt(initialSystemPrompt);
      addNotice('info', `Session log: ${sessionLogger.filePath}`);
    }

    if (opts.validationWarning) {
      addNotice('warn', `⚠ ${opts.validationWarning}`);
    }

    void loadInitialHistory(refs, addNotice);

    return () => {
      sessionLogger?.logSessionEnd();
      sessionLogger?.close();
    };
  }, []);

  function buildDeps(): AgentLoopDeps {
    return {
      refs,
      provider: opts.provider,
      agentConfig: opts.agentConfig,
      addItem,
      addNotice,
      nextId,
      refreshTokenEstimate,
      composeSystemPrompt,
      setState,
      setThinking,
      setRunningTool,
      setStreamingText,
      setCompacting,
      setSessionTurns,
      setSessionToolCalls,
      setLastUsage,
      setPermissionRequest,
      setPendingToolCall,
      setPlannedCalls,
      getPlannedCalls: () => plannedCalls,
    };
  }

  async function submitPrompt(initial: string): Promise<void> {
    const deps = buildDeps();
    let next: string | undefined = initial;
    while (next !== undefined && refs.current) {
      try {
        await processInput(next, deps);
      } catch (err) {
        addNotice('danger', `Error: ${(err as Error).message}`);
      }
      next = refs.current.inputQueue.shift();
      setQueueLength(refs.current.inputQueue.length);
      if (next !== undefined) {
        addNotice('info', `📨 processing queued: ${next.slice(0, 80)}${next.length > 80 ? '…' : ''}`);
      }
    }
    setState('idle');
    // Refresh after every turn: branch and dirty state may have changed
    // out-of-band — a Bash tool call ran `git checkout` / committed / edited
    // a tracked file, or the user switched branches in another terminal.
    // Branch surfaces in the status bar; dirty state is rebuilt into the
    // system prompt so the model sees fresh context next turn.
    void refreshGitState(deps, setGitBranch, setGitDirtyState);
  }

  function queueInput(text: string): void {
    if (!refs.current) return;
    refs.current.inputQueue.push(text);
    setQueueLength(refs.current.inputQueue.length);
    addNotice('info', `📨 queued (${refs.current.inputQueue.length} pending) — runs after current task.`);
  }

  function respondToPermission(decision: PermissionDecision): void {
    permissionRequest?.resolve(decision);
    setPermissionRequest(undefined);
  }

  function abort(): void {
    refs.current?.abort?.abort();
  }

  function clearConversation(): void {
    if (!refs.current) return;
    refs.current.conversation.clear();
    setItems([]);
    setStreamingText('');
    setLastUsage(undefined);
    refreshTokenEstimate();
    addNotice('info', 'Conversation cleared.');
  }

  async function setModelByName(name: string): Promise<void> {
    if (!refs.current) return;
    const validation = await validateModelToolSupport(opts.provider, name);
    if (validation.mode === 'unreachable') {
      addNotice('danger', validation.reason);
      return;
    }
    const prevFallback = refs.current.useTextToolFallback;
    refs.current.useTextToolFallback = validation.mode === 'fallback';
    refs.current.nativeToolSupport = validation.mode === 'native';
    if (validation.mode === 'fallback') {
      addNotice('warn', `⚠ ${validation.warning}`);
    }
    if (prevFallback !== refs.current.useTextToolFallback) {
      const sp = composeSystemPrompt();
      refs.current.conversation.updateSystemPrompt(sp);
      refs.current.sessionLogger?.logSystemPromptChange(`text-tool-fallback=${refs.current.useTextToolFallback}`);
      refs.current.sessionLogger?.logSystemPrompt(sp);
    }
    refs.current.sessionLogger?.logModelChange(refs.current.model, name);
    refs.current.model = name;
    setModel(name);
    const caps = opts.provider.getCapabilities(name);
    refs.current.contextManager = new ContextManager(refs.current.conversation, caps, {
      compactionThreshold: opts.agentConfig?.compactionThreshold,
      recencyWindow: opts.agentConfig?.recencyWindow,
    });
    addNotice('info', `Model switched to ${name}`);
  }

  function togglePlanMode(): void {
    if (!refs.current) return;
    refs.current.planMode = !refs.current.planMode;
    setPlanMode(refs.current.planMode);
    const sp = composeSystemPrompt();
    refs.current.conversation.updateSystemPrompt(sp);
    refs.current.sessionLogger?.logSystemPromptChange(`plan-mode=${refs.current.planMode}`);
    refs.current.sessionLogger?.logSystemPrompt(sp);
    addNotice('cyan', `Plan mode: ${refs.current.planMode ? 'ON' : 'OFF'}.`);
  }

  function setCorrector(value: boolean): void {
    if (!refs.current) return;
    refs.current.enableCorrector = value;
    addNotice('info', `LLM tool-call corrector: ${value ? 'ON' : 'OFF'}.`);
  }

  function setExperimentalFlag(name: keyof ExperimentalFlags, value: boolean): void {
    if (!refs.current) return;
    refs.current.experimental = { ...refs.current.experimental, [name]: value };
    // System prompt depends on lineCountHint, so refresh it on toggle.
    if (name === 'lineCountHint') {
      const sp = composeSystemPrompt();
      refs.current.conversation.updateSystemPrompt(sp);
      refs.current.sessionLogger?.logSystemPromptChange(`lineCountHint=${value}`);
      refs.current.sessionLogger?.logSystemPrompt(sp);
    }
    addNotice('info', `Experimental ${name}: ${value ? 'on' : 'off'}.`);
  }

  async function approvePlan(): Promise<void> {
    if (!refs.current) return;
    const plan = plannedCalls;
    setPlannedCalls([]);
    refs.current.planMode = false;
    setPlanMode(false);
    const sp = composeSystemPrompt();
    refs.current.conversation.updateSystemPrompt(sp);
    refs.current.sessionLogger?.logSystemPromptChange('plan-mode=false');
    refs.current.sessionLogger?.logSystemPrompt(sp);
    addNotice('cyan', `Executing ${plan.length} planned tool call${plan.length === 1 ? '' : 's'}...`);
    const summary = plan.map(p => `- ${p.toolName}: ${JSON.stringify(p.args).slice(0, 200)}`).join('\n');
    setState('running');
    try {
      await runAgentLoopInternal(
        `Execute the plan you proposed:\n${summary}\n\nIssue each tool call now.`,
        buildDeps(),
      );
    } finally {
      setState('idle');
    }
  }

  function cancelPlan(): void {
    setPlannedCalls([]);
  }

  function resetPermissions(): void {
    refs.current?.permissions.reset();
    refs.current?.sessionLogger?.logPermissionChange('reset');
  }

  function recordHistory(text: string): void {
    recordHistoryPure(refs, text);
  }

  function historyUp(currentInput: string): string | null {
    return historyUpPure(refs, currentInput);
  }

  function historyDown(): string | null {
    return historyDownPure(refs);
  }

  function setIdle(): void {
    setState('idle');
  }

  function getRunState(): RunState {
    return state;
  }

  return {
    items,
    state,
    thinking,
    compacting,
    runningTool,
    streamingText,
    permissionRequest,
    pendingToolCall,
    plannedCalls,
    planMode,
    model,
    sessionTurns,
    sessionToolCalls,
    lastUsage,
    estimatedTokens,
    queueLength,
    gitBranch,
    gitDirty,
    refs,
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
    recordHistory,
    historyUp,
    historyDown,
    addNotice,
    addNoticeBlock,
    setIdle,
    getRunState,
  };
}
