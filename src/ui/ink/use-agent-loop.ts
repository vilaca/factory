import { useState, useEffect, useRef, useCallback } from 'react';
import type { Provider } from '../../providers/types.js';
import type { AgentConfig, ExperimentalFlags } from '../../core/config-types.js';
import type { AgentEvent } from '../../core/agent-types.js';
import { Conversation } from '../../core/conversation.js';
import { ContextManager } from '../../core/context-manager.js';
import { PermissionManager } from '../../permissions.js';
import { runAgent } from '../../core/agent.js';
import { FileCache } from '../../core/agent/file-cache.js';
import { defaultRegistry } from '../../tools/index.js';
import { validateModelToolSupport } from '../../core/model-validation.js';
import {
  getTextToolFallbackPrompt,
  getPlanModePrompt,
  getLineCountHintPrompt,
  getGitStatusSnippet,
} from '../../core/system-prompt.js';
import {
  createSessionLogger,
  loadHistoryFromSessions,
  type SessionLogger,
} from '../../core/session-log.js';
import { getBuildInfo } from '../../utils/build-info.js';
import { getGitBranch, isGitDirty } from '../../utils/git.js';
import type { DisplayItem, ToolCallSummary } from './types.js';

const TRIVIAL_PROMPTS = new Set([
  'ok', 'okay', 'yes', 'no', 'y', 'n', 'go', 'go on',
  'do it', 'do the call', 'do the calls', 'continue', 'next', 'sure',
]);
const MAX_REPLAYS_PER_PROMPT = 2;

function isSubstantivePrompt(s: string): boolean {
  if (s.length >= 25) return true;
  return !TRIVIAL_PROMPTS.has(s.toLowerCase());
}

export type RunState = 'idle' | 'running' | 'awaiting-permission';
export type NoticeLevel = 'info' | 'warn' | 'danger' | 'cyan';
export type PermissionDecision = 'allow' | 'deny' | 'allow-all';

export interface PermissionRequestState {
  toolName: string;
  args: Record<string, unknown>;
  resolve: (d: PermissionDecision) => void;
}

export interface RunRefs {
  abort?: AbortController;
  sessionLogger?: SessionLogger;
  conversation: Conversation;
  permissions: PermissionManager;
  contextManager: ContextManager;
  fileCache: FileCache;
  baseSystemPrompt: string;
  pastHistory: string[];
  model: string;
  useTextToolFallback: boolean;
  nativeToolSupport: boolean;
  planMode: boolean;
  enableCorrector: boolean;
  experimental: ExperimentalFlags;
  gitBranch: string | undefined;
  gitDirty: boolean | null;
  lastSubstantivePrompt: string | null;
  replayCounts: Map<string, number>;
  tokenLimitReplayCounts: Map<string, number>;
  inputQueue: string[];
  historyIndex: number;
  historyDraft: string;
}

export interface UseAgentLoopOptions {
  model: string;
  systemPrompt: string;
  provider: Provider;
  agentConfig?: AgentConfig;
  autoAllowTools?: string[];
  useTextToolFallback?: boolean;
  nativeToolSupport?: boolean;
  enableSessionLog?: boolean;
  planMode?: boolean;
  enableCorrector?: boolean;
  mcpInfo?: { servers: string[]; toolCount: number };
  gitBranch?: string;
  gitDirty?: boolean | null;
}

export interface AgentLoopApi {
  // State
  items: DisplayItem[];
  state: RunState;
  thinking: boolean;
  compacting: { aggressive: boolean } | null;
  runningTool: string | null;
  /** In-flight assistant text that hasn't reached text-done yet. Held outside
   * `items[]` so the static history can be rendered via Ink's <Static> for
   * proper terminal scrollback. */
  streamingText: string;
  permissionRequest: PermissionRequestState | undefined;
  plannedCalls: ToolCallSummary[];
  planMode: boolean;
  model: string;
  sessionTurns: number;
  sessionToolCalls: number;
  lastUsage: { totalTokens?: number } | undefined;
  /** Approximate token count from ContextManager — used to show the status
   * bar's token figure before the first model response arrives. */
  estimatedTokens: number | undefined;
  queueLength: number;
  gitBranch: string | undefined;
  gitDirty: boolean | null;
  /** Read-only access to mutable settings/state for slash commands. */
  refs: { readonly current: RunRefs | null };

  // Actions
  submitPrompt(text: string): Promise<void>;
  queueInput(text: string): void;
  respondToPermission(decision: PermissionDecision): void;
  abort(): void;
  clearConversation(): void;
  setModelByName(name: string): Promise<void>;
  togglePlanMode(): void;
  setCorrector(value: boolean): void;
  setExperimentalFlag(name: keyof ExperimentalFlags, value: boolean): void;
  approvePlan(): Promise<void>;
  cancelPlan(): void;
  resetPermissions(): void;
  recordHistory(text: string): void;
  historyUp(currentInput: string): string | null;
  historyDown(): string | null;
  addNotice(level: NoticeLevel, text: string): void;
  setIdle(): void;
  /** Snapshot the running-state needed when handleSubmit dispatches inputs. */
  getRunState(): RunState;
}

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
  function refreshTokenEstimate(): void {
    if (!refs.current) return;
    refs.current.contextManager.updateUsage(undefined);
    setEstimatedTokens(refs.current.contextManager.getTokenEstimate());
  }

  function composeSystemPrompt(): string {
    if (!refs.current) return '';
    const parts = [refs.current.baseSystemPrompt];
    if (refs.current.useTextToolFallback) parts.push(getTextToolFallbackPrompt());
    if (refs.current.planMode) parts.push(getPlanModePrompt());
    if (refs.current.experimental.lineCountHint) parts.push(getLineCountHintPrompt());
    const git = getGitStatusSnippet(refs.current.gitDirty);
    if (git) parts.push(git);
    return parts.join('\n\n');
  }

  // One-shot initialization
  useEffect(() => {
    let sessionLogger: SessionLogger | undefined;
    if (opts.enableSessionLog !== false) {
      try {
        sessionLogger = createSessionLogger();
        const build = getBuildInfo();
        sessionLogger.logSessionStart({
          model: opts.model,
          provider: opts.provider.name,
          cwd: process.cwd(),
          experimental: opts.agentConfig?.experimental as Record<string, boolean> | undefined,
          turnTimeoutSec: opts.agentConfig?.turnTimeoutSec,
          appVersion: build.version,
          buildTimestamp: build.buildTimestamp,
          mcp: opts.mcpInfo,
          gitBranch: opts.gitBranch,
          gitDirty: opts.gitDirty,
        });
      } catch (err) {
        addNotice('warn', `(session logging disabled: ${(err as Error).message})`);
      }
    }

    const baseSystemPrompt = opts.systemPrompt;
    const useTextToolFallback = opts.useTextToolFallback ?? false;
    const initialPlanMode = opts.planMode ?? false;
    const initialExperimental: ExperimentalFlags = { ...(opts.agentConfig?.experimental ?? {}) };

    const initialGitDirty = opts.gitDirty ?? null;

    const composeInitial = (): string => {
      const parts = [baseSystemPrompt];
      if (useTextToolFallback) parts.push(getTextToolFallbackPrompt());
      if (initialPlanMode) parts.push(getPlanModePrompt());
      if (initialExperimental.lineCountHint) parts.push(getLineCountHintPrompt());
      const git = getGitStatusSnippet(initialGitDirty);
      if (git) parts.push(git);
      return parts.join('\n\n');
    };

    const conversation = new Conversation(composeInitial());
    const permissions = new PermissionManager();
    if (opts.autoAllowTools) {
      for (const t of opts.autoAllowTools) permissions.allowAll(t);
    }
    const capabilities = opts.provider.getCapabilities(opts.model);
    const contextManager = new ContextManager(conversation, capabilities, {
      compactionThreshold: opts.agentConfig?.compactionThreshold,
      recencyWindow: opts.agentConfig?.recencyWindow,
    });

    refs.current = {
      sessionLogger,
      conversation,
      permissions,
      contextManager,
      fileCache: new FileCache(),
      baseSystemPrompt,
      pastHistory: [],
      model: opts.model,
      useTextToolFallback,
      nativeToolSupport: opts.nativeToolSupport ?? true,
      planMode: initialPlanMode,
      enableCorrector: opts.enableCorrector ?? true,
      experimental: initialExperimental,
      gitBranch: opts.gitBranch,
      gitDirty: initialGitDirty,
      lastSubstantivePrompt: null,
      replayCounts: new Map(),
      tokenLimitReplayCounts: new Map(),
      inputQueue: [],
      historyIndex: -1,
      historyDraft: '',
    };

    // Seed the token estimate so the status bar shows the system prompt's
    // baseline before the first model response.
    contextManager.updateUsage(undefined);
    setEstimatedTokens(contextManager.getTokenEstimate());

    if (sessionLogger) {
      addNotice('info', `Session log: ${sessionLogger.filePath}`);
    }

    void loadHistoryFromSessions().then((h) => {
      if (refs.current) refs.current.pastHistory = h;
      if (h.length > 0) {
        addNotice('info', `Loaded ${h.length} prior input${h.length === 1 ? '' : 's'} (press up to recall).`);
      }
    });

    return () => {
      sessionLogger?.logSessionEnd();
      sessionLogger?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Agent run loop ────────────────────────────────────────────────

  type StreamingState = {
    getStreamingBuffer: () => string;
    setStreamingBuffer: (s: string) => void;
    addSuccessfulToolCall: () => void;
    markAutoRetryExhausted: () => void;
    markTokenLimitHalt: () => void;
  };

  function handleAgentEvent(event: AgentEvent, ss: StreamingState): void {
    if (!refs.current) return;

    switch (event.type) {
      case 'text-chunk': {
        setThinking(false);
        const next = ss.getStreamingBuffer() + event.content;
        ss.setStreamingBuffer(next);
        setStreamingText(next);
        break;
      }
      case 'text-done': {
        // Commit the finalized text to items[] (which feeds <Static>) and
        // clear the streaming buffer. <Static> keeps history in the terminal's
        // real scrollback; only the streaming buffer + spinner re-render.
        if (event.fullContent) {
          addItem({ kind: 'assistant-text', id: nextId(), text: event.fullContent, streaming: false });
        }
        ss.setStreamingBuffer('');
        setStreamingText('');
        setThinking(true);
        refreshTokenEstimate();
        break;
      }
      case 'tool-call-start': {
        setThinking(false);
        setRunningTool(event.toolName);
        addItem({ kind: 'tool-call', id: nextId(), toolName: event.toolName, args: event.args });
        break;
      }
      case 'tool-call-result': {
        addItem({
          kind: 'tool-result',
          id: nextId(),
          toolName: event.toolName,
          output: event.result.displayOutput ?? event.result.output,
          success: event.result.success,
          empty: event.result.empty,
        });
        if (event.result.success) ss.addSuccessfulToolCall();
        setSessionToolCalls((n) => n + 1);
        setRunningTool(null);
        setThinking(true);
        // Tool results add (often large) chunks to the conversation.
        refreshTokenEstimate();
        break;
      }
      case 'tool-call-denied': {
        addItem({ kind: 'tool-denied', id: nextId(), toolName: event.toolName });
        setRunningTool(null);
        break;
      }
      case 'tool-call-recovered': {
        if (!refs.current.useTextToolFallback) {
          const sourceLabel =
            event.source === 'bare' ? 'bare JSON' :
            event.source === 'fence' ? 'a JSON code block' :
            event.source === 'shell-fence' ? 'a shell code block' :
            'tagged JSON';
          addNotice('warn',
            `⚠ Model emitted tool call as ${sourceLabel} instead of structured tool_calls. Recovered ${event.count} call${event.count === 1 ? '' : 's'} via fallback parser.`,
          );
          refs.current.useTextToolFallback = true;
          refs.current.conversation.updateSystemPrompt(composeSystemPrompt());
          refs.current.sessionLogger?.logSystemPromptChange('text-tool-fallback=true (auto)');
          addNotice('warn',
            '⚠ Auto-enabling text-tool fallback mode — model will be instructed to use <tool_call> format from now on. Subsequent recoveries will be silent.',
          );
        }
        break;
      }
      case 'tool-result-imitation-stripped': {
        addNotice('danger',
          `⚠ Model fabricated ${event.count} tool result block${event.count === 1 ? '' : 's'} in its response. Stripped before storing — the result was NOT real.`,
        );
        break;
      }
      case 'auto-retry-injected': {
        addNotice('warn',
          `↻ Model bailed after a tool failure — auto-injecting retry nudge (${event.remainingBudget} retr${event.remainingBudget === 1 ? 'y' : 'ies'} left).`,
        );
        break;
      }
      case 'auto-retry-exhausted': {
        ss.markAutoRetryExhausted();
        addNotice('warn', '⚠ Auto-retry exhausted — model couldn\'t recover on its own.');
        break;
      }
      case 'all-denied-halt': {
        addNotice('warn',
          `⏸ All ${event.count} tool call${event.count === 1 ? '' : 's'} this turn were denied — halting. Tell the model what to do differently.`,
        );
        break;
      }
      case 'tool-call-corrected': {
        addNotice('warn',
          `↺ Auto-correcting ${event.original.function.name} call (${event.reason.slice(0, 80)})...`,
        );
        break;
      }
      case 'tool-call-corrector-aborted': {
        addNotice('info', `↺ Corrector skipped: ${event.reason.slice(0, 100)}`);
        break;
      }
      case 'tool-call-planned': {
        const sig = `${event.toolName}:${JSON.stringify(event.args)}`;
        const dup = plannedCalls.some(p => `${p.toolName}:${JSON.stringify(p.args)}` === sig);
        if (dup) {
          addNotice('info', `[planned] (skipped duplicate ${event.toolName} call)`);
        } else {
          setPlannedCalls((prev) => [...prev, { toolName: event.toolName, args: event.args }]);
          addItem({ kind: 'tool-planned', id: nextId(), toolName: event.toolName, args: event.args });
        }
        break;
      }
      case 'permission-request': {
        setState('awaiting-permission');
        const respond = event.respond;
        const toolName = event.toolName;
        setPermissionRequest({
          toolName,
          args: event.args,
          resolve: (decision) => {
            refs.current?.sessionLogger?.logPermissionChange(`request:${decision}`, toolName);
            respond(decision);
            setPermissionRequest(undefined);
            setState('running');
          },
        });
        break;
      }
      case 'output-cap-reached': {
        addNotice('warn',
          `⚠ Output cap reached (${event.completionTokens} tokens). Response was truncated — ask for the rest if needed.`,
        );
        break;
      }
      case 'empty-turn-warning': {
        addNotice('warn',
          `⚠ Model produced ${event.completionTokens} tokens of internal reasoning but no visible output. ` +
          `Try a different model or a more concrete prompt.`,
        );
        break;
      }
      case 'repetition-detected': {
        addNotice('danger',
          `⚠ Runaway repetition (${event.streak} identical lines: ${event.line.slice(0, 60)}). Aborting.`,
        );
        break;
      }
      case 'read-cache-hit': {
        addNotice('info', `⤳ Read cache hit: ${event.path} unchanged`);
        break;
      }
      case 'bash-dedup-nudge': {
        addNotice('warn',
          `↻ Near-duplicate Bash pattern (${event.recentCommands.length} recent commands) — nudge injected.`,
        );
        break;
      }
      case 'compaction-start': {
        setCompacting({ aggressive: event.aggressive });
        setThinking(false);
        addNotice(
          'info',
          event.aggressive
            ? '⊕ Context full — aggressively compacting (mechanical summary)…'
            : '⊕ Compacting conversation history…',
        );
        break;
      }
      case 'compaction': {
        setCompacting(null);
        setThinking(true);
        addNotice(
          'info',
          `✓ Compacted ${event.oldMessages} messages → ${event.newMessages}` +
            (event.aggressive ? ' (aggressive pass)' : ''),
        );
        // Conversation just shrank — refresh so the status bar reflects it
        // before the next model response.
        refreshTokenEstimate();
        break;
      }
      case 'error': {
        addNotice('danger', `Error: ${event.error.message}`);
        break;
      }
      case 'turn-complete': {
        setSessionTurns((n) => n + event.turnsUsed);
        if (event.usage) {
          setLastUsage(event.usage);
        }
        if (event.stopReason === 'turn-limit') {
          addNotice('warn', '(stopped: maximum turns reached)');
        } else if (event.stopReason === 'token-limit') {
          ss.markTokenLimitHalt();
        }
        break;
      }
    }
  }

  async function runAgentLoopInternal(userInput: string): Promise<void> {
    if (!refs.current) return;
    refs.current.abort = new AbortController();
    setThinking(true);

    let successfulToolCallsThisRun = 0;
    let autoRetryExhaustedThisRun = false;
    let tokenLimitHaltThisRun = false;

    let assistantBuffer = '';

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutSec = opts.agentConfig?.turnTimeoutSec;
    if (timeoutSec) {
      timeoutHandle = setTimeout(() => {
        addNotice('warn', `⏱ Turn timeout (${timeoutSec}s) — aborting.`);
        refs.current?.abort?.abort();
      }, timeoutSec * 1000);
    }

    const agent = runAgent(userInput, {
      provider: opts.provider,
      model: refs.current.model,
      conversation: refs.current.conversation,
      permissions: refs.current.permissions,
      toolRegistry: defaultRegistry,
      useTextToolFallback: refs.current.useTextToolFallback,
      nativeToolSupport: refs.current.nativeToolSupport,
      planMode: refs.current.planMode,
      enableCorrector: refs.current.enableCorrector,
      contextManager: refs.current.contextManager,
      maxTurns: opts.agentConfig?.maxTurns,
      experimental: {
        bashDedup: refs.current.experimental.bashDedup,
        readCache: refs.current.experimental.readCache,
      },
      fileCache: refs.current.fileCache,
      signal: refs.current.abort.signal,
    });

    for await (const event of agent) {
      if (event.type !== 'text-chunk') {
        refs.current.sessionLogger?.logAgentEvent(event);
      }
      handleAgentEvent(event, {
        getStreamingBuffer: () => assistantBuffer,
        setStreamingBuffer: (s) => { assistantBuffer = s; },
        addSuccessfulToolCall: () => successfulToolCallsThisRun++,
        markAutoRetryExhausted: () => { autoRetryExhaustedThisRun = true; },
        markTokenLimitHalt: () => { tokenLimitHaltThisRun = true; },
      });
    }

    if (tokenLimitHaltThisRun) {
      const replay = refs.current.lastSubstantivePrompt ?? userInput;
      const used = refs.current.tokenLimitReplayCounts.get(replay) ?? 0;
      if (used < 1) {
        refs.current.tokenLimitReplayCounts.set(replay, used + 1);
        addNotice('warn', '⏵ Context window full — aggressively compacted; replaying prompt once.');
        await runAgentLoopInternal(replay);
        return;
      }
      addNotice('danger', '⚠ Compaction couldn\'t free enough context. Use /clear and rephrase.');
    }

    // Auto-recovery: clear+replay if no successful tool call this run.
    if (
      autoRetryExhaustedThisRun &&
      successfulToolCallsThisRun === 0 &&
      refs.current.lastSubstantivePrompt
    ) {
      const replay = refs.current.lastSubstantivePrompt;
      const used = refs.current.replayCounts.get(replay) ?? 0;
      if (used < MAX_REPLAYS_PER_PROMPT) {
        refs.current.replayCounts.set(replay, used + 1);
        addNotice('danger',
          `⚠ Auto-recovery: clearing conversation and replaying the last substantive prompt (attempt ${used + 1}/${MAX_REPLAYS_PER_PROMPT}).`,
        );
        refs.current.conversation.clear();
        await runAgentLoopInternal(replay);
        return;
      }
      addNotice('danger',
        `⚠ Auto-recovery exhausted after ${MAX_REPLAYS_PER_PROMPT} replays — model couldn't make progress on this prompt. Giving up; please rephrase or take over manually.`,
      );
    }

    if (refs.current.planMode && plannedCalls.length > 0) {
      addNotice('cyan',
        `Proposed plan: ${plannedCalls.length} change${plannedCalls.length === 1 ? '' : 's'}.`,
      );
      addNotice('info', 'Type y to approve, n to drop, or describe revisions.');
    }

    if (timeoutHandle) clearTimeout(timeoutHandle);
    refs.current.abort = undefined;
    setThinking(false);
    setRunningTool(null);
    setCompacting(null);
  }

  async function processInput(trimmed: string): Promise<void> {
    if (!refs.current) return;

    refs.current.sessionLogger?.logUserInput(trimmed);
    addItem({ kind: 'user-input', id: nextId(), text: trimmed });

    if (isSubstantivePrompt(trimmed)) {
      refs.current.lastSubstantivePrompt = trimmed;
    }

    setState('running');
    await runAgentLoopInternal(trimmed);
  }

  async function submitPrompt(initial: string): Promise<void> {
    let next: string | undefined = initial;
    while (next !== undefined && refs.current) {
      try {
        await processInput(next);
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
    void refreshGitState();
  }

  async function refreshGitState(): Promise<void> {
    if (!refs.current) return;
    try {
      const [branch, dirty] = await Promise.all([
        getGitBranch(process.cwd()),
        isGitDirty(process.cwd()),
      ]);
      const prevBranch = refs.current.gitBranch;
      const prevDirty = refs.current.gitDirty;
      if (branch === prevBranch && dirty === prevDirty) return;
      refs.current.gitBranch = branch;
      refs.current.gitDirty = dirty;
      if (branch !== prevBranch) setGitBranch(branch);
      if (dirty !== prevDirty) {
        setGitDirtyState(dirty);
        refs.current.conversation.updateSystemPrompt(composeSystemPrompt());
        refreshTokenEstimate();
      }
      refs.current.sessionLogger?.logGitChange(
        { branch: prevBranch, dirty: prevDirty },
        { branch, dirty },
      );
    } catch (err) {
      addNotice('warn', `⚠ Could not refresh git state: ${(err as Error).message}`);
      refs.current.sessionLogger?.logWarning('git-refresh', (err as Error).message);
    }
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
      refs.current.conversation.updateSystemPrompt(composeSystemPrompt());
      refs.current.sessionLogger?.logSystemPromptChange(`text-tool-fallback=${refs.current.useTextToolFallback}`);
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
    refs.current.conversation.updateSystemPrompt(composeSystemPrompt());
    refs.current.sessionLogger?.logSystemPromptChange(`plan-mode=${refs.current.planMode}`);
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
      refs.current.conversation.updateSystemPrompt(composeSystemPrompt());
      refs.current.sessionLogger?.logSystemPromptChange(`lineCountHint=${value}`);
    }
    addNotice('info', `Experimental ${name}: ${value ? 'on' : 'off'}.`);
  }

  async function approvePlan(): Promise<void> {
    if (!refs.current) return;
    const plan = plannedCalls;
    setPlannedCalls([]);
    refs.current.planMode = false;
    setPlanMode(false);
    refs.current.conversation.updateSystemPrompt(composeSystemPrompt());
    refs.current.sessionLogger?.logSystemPromptChange('plan-mode=false');
    addNotice('cyan', `Executing ${plan.length} planned tool call${plan.length === 1 ? '' : 's'}...`);
    const summary = plan.map(p => `- ${p.toolName}: ${JSON.stringify(p.args).slice(0, 200)}`).join('\n');
    setState('running');
    try {
      await runAgentLoopInternal(`Execute the plan you proposed:\n${summary}\n\nIssue each tool call now.`);
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
    if (!refs.current) return;
    refs.current.historyIndex = -1;
    refs.current.historyDraft = '';
    const h = refs.current.pastHistory;
    if (text && h[0] !== text) {
      h.unshift(text);
    }
  }

  function historyUp(currentInput: string): string | null {
    if (!refs.current) return null;
    const history = refs.current.pastHistory;
    if (history.length === 0) return null;
    if (refs.current.historyIndex === -1) {
      refs.current.historyDraft = currentInput;
      refs.current.historyIndex = 0;
    } else if (refs.current.historyIndex < history.length - 1) {
      refs.current.historyIndex++;
    }
    return history[refs.current.historyIndex];
  }

  function historyDown(): string | null {
    if (!refs.current) return null;
    if (refs.current.historyIndex === -1) return null;
    if (refs.current.historyIndex > 0) {
      refs.current.historyIndex--;
      return refs.current.pastHistory[refs.current.historyIndex];
    }
    refs.current.historyIndex = -1;
    return refs.current.historyDraft;
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
    setIdle,
    getRunState,
  };
}
