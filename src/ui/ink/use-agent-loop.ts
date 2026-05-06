import { useState, useEffect, useRef, useCallback } from 'react';
import { ContextManager } from '../../core/context-manager.js';
import { validateModelToolSupport } from '../../core/model-validation.js';
import { createProvider } from '../../providers/registry.js';
import { descriptorByAlias } from '../../providers/descriptors.js';
import { loadGlobalConfig } from '../../core/config.js';
import { getKey } from '../../core/credentials.js';
import * as fs from 'fs';
import * as path from 'path';
import type { ExperimentalFlags } from '../../core/config-types.js';
import type { Provider } from '../../providers/types.js';
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
  const [providerName, setProviderName] = useState(opts.provider.name);
  const [sessionTurns, setSessionTurns] = useState(0);
  const [sessionToolCalls, setSessionToolCalls] = useState(0);
  const [lastUsage, setLastUsage] = useState<{
    totalTokens?: number;
    completionTokens?: number;
    cachedPromptTokens?: number;
    cacheCreationTokens?: number;
    promptTokens?: number;
  } | undefined>();
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
  const [cwd, setCwdState] = useState<string>(process.cwd());
  const [emojiMode, setEmojiMode] = useState(false);
  const [userEmoji, setUserEmojiState] = useState<string | undefined>(undefined);

  const idCounter = useRef(0);
  const nextId = useCallback(() => ++idCounter.current, []);
  const refs = useRef<RunRefs | null>(null);

  function addItem(item: DisplayItem): void {
    setItems((prev) => [...prev, item]);
  }
  function addNotice(level: NoticeLevel, text: string): void {
    addItem({ kind: 'notice', id: nextId(), text, level });
  }
  function addNoticeBlock(lines: { level: NoticeLevel; text: string; bold?: boolean }[]): void {
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
      subagents: refs.current.experimental.subagents ?? false,
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
      subagents: initialExperimental.subagents ?? false,
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

    // Sync cwd state with the freshly-seeded refs.cwd (createInitialRefs uses
    // process.cwd() at creation time; useState's lazy init may have captured a
    // different value if process.cwd() shifted in between).
    setCwdState(refs.current.cwd);

    if (sessionLogger) {
      sessionLogger.logSystemPrompt(initialSystemPrompt);
      addNotice('info', `Session log: ${sessionLogger.filePath}`);
    }

    if (opts.validationWarning) {
      addNotice('warn', `⚠ ${opts.validationWarning}`);
    }

    void loadInitialHistory(refs, addNotice);

    return () => {
      // Closing a tab while its agent is still running: signal abort so the
      // run-loop unwinds promptly instead of writing to React state on the
      // unmounted Session and continuing to spawn tools.
      refs.current?.abort?.abort();
      sessionLogger?.logSessionEnd();
      sessionLogger?.close();
    };
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
    // Support `provider:model` so the user can switch both in one shot —
    // useful so they don't end up on a provider whose default model isn't
    // valid for it.
    if (name.includes(':')) {
      const [providerPart, ...rest] = name.split(':');
      const modelPart = rest.join(':');
      if (!providerPart || !modelPart) {
        addNotice('warn', 'Usage: /model <name> or /model <provider>:<model>');
        return;
      }
      await setProviderByName(providerPart, modelPart);
      return;
    }
    const provider = refs.current.provider;
    const validation = await validateModelToolSupport(provider, name);
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
    refs.current.primary = { provider: refs.current.provider.name, model: name };
    setModel(name);
    const caps = provider.getCapabilities(name);
    refs.current.contextManager = new ContextManager(refs.current.conversation, caps, {
      compactionThreshold: opts.agentConfig?.compactionThreshold,
      recencyWindow: opts.agentConfig?.recencyWindow,
      recencyTokens: opts.agentConfig?.recencyTokens,
      toolResultAgingTurns: opts.agentConfig?.toolResultAgingTurns,
    });
    addNotice('info', `Model switched to ${name}`);
  }

  // Swap to another provider. We don't drive auth flows from inside the
  // running CLI — providers fall back to env-var/config-file credentials. If
  // the user hasn't authed yet, `createProvider` throws and we surface the
  // hint. If a model is supplied (via `/provider <name> <model>` or as
  // `provider:model` from /model), validate and apply it; otherwise fall
  // back to a sensible default by listing the new provider's models.
  async function setProviderByName(name: string, requestedModel?: string, keyId?: string): Promise<void> {
    if (!refs.current) return;
    const trimmed = name.trim();
    if (!trimmed) {
      addNotice('info', `Current provider: ${refs.current.provider.name}`);
      return;
    }
    if (trimmed === refs.current.provider.name && !keyId) {
      if (requestedModel) await setModelByName(requestedModel);
      else addNotice('info', `Already on ${trimmed}.`);
      return;
    }
    // Resolve credentials from the multi-key store. Without this the
    // mid-session switch would call createProvider({}) and the provider
    // would have to fall back to env vars, which most users don't have set
    // (their token lives only in factory's config). With keyId, target
    // that specific saved key; without, take the first key (matches the
    // post-migration "default" entry).
    const descriptor = descriptorByAlias(trimmed);
    const createOpts: Parameters<typeof createProvider>[1] = {};
    // Resolve the key id we actually built the provider with — even when
    // the caller passed no explicit keyId, getKey returns the first stored
    // entry. Tracking that id is what lets per-key stats land correctly
    // after a /provider swap; otherwise refs.activeKeyId stays undefined
    // and the success/failure recorders skip silently.
    let resolvedKeyId: string | undefined = keyId;
    if (descriptor) {
      try {
        const cfg = await loadGlobalConfig();
        const key = getKey(cfg, descriptor.name, keyId);
        if (key) {
          createOpts.token = key.token;
          if (descriptor.needsAccountId && key.extras?.accountId) {
            createOpts.accountId = key.extras.accountId;
          }
          resolvedKeyId = key.id;
        }
      } catch {
        // Fall through with empty opts; provider may still pick up env vars.
      }
    }
    let nextProvider: Provider;
    try {
      nextProvider = createProvider(trimmed, createOpts);
    } catch (err) {
      addNotice('danger', `Cannot switch to ${trimmed}: ${(err as Error).message}`);
      return;
    }
    let nextModel: string | undefined = requestedModel;
    if (!nextModel) {
      try {
        const list = await nextProvider.listModels();
        nextModel = list[0];
      } catch (err) {
        addNotice('danger', `Cannot list models for ${trimmed}: ${(err as Error).message}`);
        return;
      }
      if (!nextModel) {
        addNotice('warn', `${trimmed} returned no models. Pass one explicitly: /provider ${trimmed} <model>`);
        return;
      }
    }
    const validation = await validateModelToolSupport(nextProvider, nextModel);
    if (validation.mode === 'unreachable') {
      addNotice('danger', validation.reason);
      return;
    }
    refs.current.sessionLogger?.logModelChange(refs.current.model, nextModel, resolvedKeyId);
    refs.current.provider = nextProvider;
    refs.current.model = nextModel;
    refs.current.primary = { provider: nextProvider.name, model: nextModel };
    refs.current.activeKeyId = resolvedKeyId;
    refs.current.useTextToolFallback = validation.mode === 'fallback';
    refs.current.nativeToolSupport = validation.mode === 'native';
    setProviderName(nextProvider.name);
    setModel(nextModel);
    if (validation.mode === 'fallback') {
      addNotice('warn', `⚠ ${validation.warning}`);
    }
    const caps = nextProvider.getCapabilities(nextModel);
    refs.current.contextManager = new ContextManager(refs.current.conversation, caps, {
      compactionThreshold: opts.agentConfig?.compactionThreshold,
      recencyWindow: opts.agentConfig?.recencyWindow,
      recencyTokens: opts.agentConfig?.recencyTokens,
      toolResultAgingTurns: opts.agentConfig?.toolResultAgingTurns,
    });
    refreshTokenEstimate();
    addNotice('info', `Provider → ${nextProvider.name}, model → ${nextModel}`);
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
    setEmojiMode((prev) => {
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
    if (resolved.startsWith('~')) resolved = (process.env.HOME ?? '') + resolved.slice(1);
    resolved = path.resolve(refs.current.cwd, resolved);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        addNotice('warn', `cwd: ${resolved} is not a directory.`);
        return;
      }
    } catch (err) {
      addNotice('warn', `cwd: ${resolved} — ${(err as Error).message}`);
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
