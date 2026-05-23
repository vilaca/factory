import { useState, useEffect, useRef, useCallback } from 'react';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ExperimentalFlags } from '../../../core/config/types.js';
import type { DisplayItem, ToolCallSummary } from '../types.js';
import { composeSystemPrompt as composeSystemPromptPure } from './compose-system-prompt.js';
import { runAgentLoopInternal, processInput } from './run-loop.js';
import { refreshGitState } from './git-state.js';
import {
  recordHistory as recordHistoryPure,
  historyUp as historyUpPure,
  historyDown as historyDownPure,
} from './history.js';
import { errorMessage } from '../../../utils/errors.js';
import { mountSession } from './setup.js';
import { swapModel, swapProvider } from './swap.js';
import type {
  AgentLoopApi,
  AgentLoopDeps,
  NoticeLevel,
  PermissionDecision,
  PermissionRequestState,
  RunRefs,
  RunState,
  UseAgentLoopOptions,
} from './agent-loop-types.js';
import type { PromptTokensCarrier } from '../../../providers/usage.js';

export type { AgentLoopApi };

// eslint-disable-next-line max-lines-per-function -- TODO(complexity): extract action handlers (run, cancel, pick, plan-resume) into separate hooks.
export function useAgentLoop(opts: UseAgentLoopOptions): AgentLoopApi {
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [state, setState] = useState<RunState>('idle');
  const [plannedCalls, setPlannedCalls] = useState<ToolCallSummary[]>([]);
  const [planMode, setPlanMode] = useState(opts.planMode ?? false);
  const [model, setModel] = useState(opts.model);
  const [providerName, setProviderName] = useState(opts.provider.name);
  const [sessionTurns, setSessionTurns] = useState(0);
  const [sessionToolCalls, setSessionToolCalls] = useState(0);
  // The only consumer of this state is the status-bar context-fullness
  // gauge, which reads it through `contextFillTokens` (see
  // src/providers/usage.ts). Narrow the carrier to just the field that
  // selector reads — future plucking of e.g. `totalTokens` (the 44aeb26
  // bug shape) becomes a compile error. Other usage fields (completion,
  // reasoning, cache*) flow through session-level event handlers, not
  // through this React state.
  const [lastUsage, setLastUsage] = useState<PromptTokensCarrier | undefined>();
  const [estimatedTokens, setEstimatedTokens] = useState<number | undefined>();
  // Mirrors ContextManager.contextWindow so the StatusBar re-renders when an
  // async provider prime (ollama's /api/show) widens or narrows the window
  // after mount. Seeded from the synchronous estimate; setup.ts and swap.ts
  // call setContextWindow when the prime resolves.
  const [contextWindow, setContextWindow] = useState<number>(
    () => opts.provider.getCapabilities(opts.model).contextWindow,
  );
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequestState | undefined>();
  const [pendingToolCall, setPendingToolCall] = useState<ToolCallSummary | null>(null);
  const [queueLength, setQueueLength] = useState(0);
  const [thinking, setThinking] = useState(false);
  const [compacting, setCompacting] = useState<{ aggressive: boolean } | null>(null);
  const [runningTool, setRunningTool] = useState<string | null>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [gitBranch, setGitBranch] = useState<string | undefined>(opts.gitBranch);
  const [gitDirty, setGitDirtyState] = useState<boolean | null>(opts.gitDirty ?? null);
  const [cwd, setCwdState] = useState<string>(process.cwd());
  const [emojiMode, setEmojiMode] = useState(false);
  const [userEmoji, setUserEmojiState] = useState<string | undefined>(undefined);

  const idCounter = useRef(0);
  const nextId = useCallback(() => ++idCounter.current, []);
  const refs = useRef<RunRefs | null>(null);

  function addItem(item: DisplayItem): void {
    setItems(prev => [...prev, item]);
  }
  function addNotice(level: NoticeLevel, text: string): void {
    addItem({ kind: 'notice', id: nextId(), text, level });
    if (level === 'danger' || level === 'warn') {
      refs.current?.sessionLogger?.logWarning(`notice:${level}`, text);
    }
  }
  function addNoticeBlock(lines: { level: NoticeLevel; text: string; bold?: boolean }[]): void {
    addItem({ kind: 'notice-block', id: nextId(), lines });
    for (const line of lines) {
      if (line.level === 'danger' || line.level === 'warn') {
        refs.current?.sessionLogger?.logWarning(`notice:${line.level}`, line.text);
      }
    }
  }
  function refreshTokenEstimate(): void {
    if (!refs.current) return;
    const defs = refs.current.useTextToolFallback ? [] : refs.current.toolRegistry.getDefinitions();
    refs.current.contextManager.refreshEstimate(defs);
    setEstimatedTokens(refs.current.contextManager.getTokenEstimate());
  }

  function composeSystemPrompt(): string {
    if (!refs.current) return '';
    return composeSystemPromptPure({
      baseSystemPrompt: refs.current.baseSystemPrompt,
      useTextToolFallback: refs.current.useTextToolFallback,
      planMode: refs.current.planMode,
      lineCountHint: refs.current.experimental.lineCountHint ?? false,
      subagents: refs.current.experimental.subagents ?? false,
      gitDirty: refs.current.gitDirty,
      alwaysOnSkills: refs.current.skills?.alwaysOnSection() ?? '',
    });
  }

  // One-shot session mount. mountSession owns the imperative wiring of
  // session logger, refs, skills, hook fires, and the matching SessionEnd
  // teardown — all of which used to live inline here. Empty deps array
  // pins it to a single fire on mount; the returned cleanup runs on
  // unmount.
  useEffect(() => {
    return mountSession(opts, {
      refs,
      addNotice,
      setEstimatedTokens,
      setContextWindow,
      setCwdState,
      composeSystemPrompt,
    });
  }, []);

  function buildDeps(): AgentLoopDeps {
    return {
      refs,
      agentConfig: opts.agentConfig,
      addItem,
      addNotice,
      nextId,
      refreshTokenEstimate,
      composeSystemPrompt,
      setState,
      setThinking,
      setRunningTool,
      setActivity,
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
        addNotice('danger', `Error: ${errorMessage(err)}`);
      }
      next = refs.current.inputQueue.shift();
      setQueueLength(refs.current.inputQueue.length);
      if (next !== undefined) {
        addNotice(
          'info',
          `📨 processing queued: ${next.slice(0, 80)}${next.length > 80 ? '…' : ''}`,
        );
      }
    }
    setState('idle');
    // Sync cwd state in case Bash ran `cd` during the turn — run-loop already
    // wrote refs.current.cwd; pull it into React state for the StatusBar.
    if (refs.current && refs.current.cwd !== cwd) {
      setCwdState(refs.current.cwd);
    }
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
    addNotice(
      'info',
      `📨 queued (${refs.current.inputQueue.length} pending) — runs after current task.`,
    );
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
    refs.current.responsesChain = undefined;
    setItems([]);
    setStreamingText('');
    setLastUsage(undefined);

    // Restore the text-tool fallback flag to whatever the model's validated
    // tool support says. The event-handler auto-flips useTextToolFallback to
    // true on first text-tool recovery (one-way), so without this reset the
    // system prompt stays in the fallback variant after /clear and keeps
    // telling the model to emit tool calls as bare JSON/code fences. The
    // invariant `useTextToolFallback === !nativeToolSupport` is what init.ts
    // and swap.ts both establish, so /clear restores it here.
    const fallbackWasAutoFlipped =
      refs.current.useTextToolFallback && refs.current.nativeToolSupport;
    refs.current.useTextToolFallback = !refs.current.nativeToolSupport;
    refs.current.conversation.updateSystemPrompt(composeSystemPrompt());

    // TODO: /clear should also clear the screen, not just the conversation state.
    refreshTokenEstimate();
    addNotice('info', 'Conversation cleared.');
    if (fallbackWasAutoFlipped) {
      addNotice('info', 'Text-tool fallback reset; back to native tool calls.');
    }
  }

  function buildSwapCtx(): Parameters<typeof swapModel>[1] {
    return {
      refs,
      opts,
      addNotice,
      setModel,
      setProviderName,
      setContextWindow,
      refreshTokenEstimate,
      composeSystemPrompt,
    };
  }

  async function setModelByName(name: string): Promise<void> {
    await swapModel(name, buildSwapCtx());
  }

  async function setProviderByName(
    name: string,
    requestedModel?: string,
    keyId?: string,
  ): Promise<void> {
    await swapProvider(name, requestedModel, keyId, buildSwapCtx());
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

  function toggleEmojiMode(): void {
    setEmojiMode(prev => {
      const next = !prev;
      addNotice('info', `Emoji mode: ${next ? 'ON 🤖' : 'OFF'}.`);
      return next;
    });
  }

  function setUserEmoji(emoji: string): void {
    const trimmed = emoji.trim();
    if (!trimmed) {
      addNotice('warn', 'Usage: /emoji <emoji>  (no arg toggles on/off)');
      return;
    }
    setUserEmojiState(trimmed);
    setEmojiMode(true);
    addNotice('info', `User emoji: ${trimmed} (emoji mode ON).`);
  }

  function setExperimentalFlag(name: keyof ExperimentalFlags, value: boolean): void {
    if (!refs.current) return;
    refs.current.experimental = { ...refs.current.experimental, [name]: value };
    // System prompt depends on lineCountHint and subagents, so refresh it
    // when either toggles.
    if (name === 'lineCountHint' || name === 'subagents') {
      const sp = composeSystemPrompt();
      refs.current.conversation.updateSystemPrompt(sp);
      refs.current.sessionLogger?.logSystemPromptChange(`${name}=${value}`);
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
    addNotice(
      'cyan',
      `Executing ${plan.length} planned tool call${plan.length === 1 ? '' : 's'}...`,
    );
    const summary = plan
      .map(p => `- ${p.toolName}: ${JSON.stringify(p.args).slice(0, 200)}`)
      .join('\n');
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

  // Validate and apply a cwd change. Empty/missing arg is treated as "show
  // current cwd". Relative paths resolve against the *current* refs.cwd, not
  // process.cwd() — so `/cwd ../sibling` works as expected from a per-tab
  // working directory.
  function setCwd(target: string): void {
    if (!refs.current) return;
    const trimmed = target.trim();
    if (!trimmed) {
      addNotice('info', `cwd: ${refs.current.cwd}`);
      return;
    }
    let resolved = trimmed;
    if (resolved.startsWith('~')) resolved = os.homedir() + resolved.slice(1);
    resolved = path.resolve(refs.current.cwd, resolved);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        addNotice('warn', `cwd: ${resolved} is not a directory.`);
        return;
      }
    } catch (err) {
      addNotice('warn', `cwd: ${resolved} — ${errorMessage(err)}`);
      return;
    }
    refs.current.cwd = resolved;
    setCwdState(resolved);
    addNotice('info', `📁 cwd → ${resolved}`);
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
    activity,
    streamingText,
    permissionRequest,
    pendingToolCall,
    plannedCalls,
    planMode,
    providerName,
    model,
    sessionTurns,
    sessionToolCalls,
    lastUsage,
    estimatedTokens,
    contextWindow,
    queueLength,
    gitBranch,
    gitDirty,
    cwd,
    emojiMode,
    userEmoji,
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
    setCwd,
    setProviderByName,
    recordHistory,
    historyUp,
    historyDown,
    addNotice,
    addNoticeBlock,
    setIdle,
    toggleEmojiMode,
    setUserEmoji,
    getRunState,
  };
}
