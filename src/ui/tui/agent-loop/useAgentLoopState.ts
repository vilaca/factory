import type React from 'react';
import { useState, useRef, useCallback } from 'react';
import type { PromptTokensCarrier } from '../../../providers/usage.js';
import type { DisplayItem, ToolCallSummary } from '../types.js';
import { createDiagnosticEmitter, sessionLogDiagnosticSink } from '../../diagnostics.js';
import { composeSystemPrompt as composeSystemPromptPure } from './compose-system-prompt.js';
import type {
  NoticeLevel,
  PermissionRequestState,
  RunRefs,
  RunState,
  UseAgentLoopOptions,
} from './agent-loop-types.js';

export interface AgentLoopStateStore {
  items: DisplayItem[];
  setItems: React.Dispatch<React.SetStateAction<DisplayItem[]>>;
  state: RunState;
  setState: React.Dispatch<React.SetStateAction<RunState>>;
  plannedCalls: ToolCallSummary[];
  setPlannedCalls: React.Dispatch<React.SetStateAction<ToolCallSummary[]>>;
  planMode: boolean;
  setPlanMode: React.Dispatch<React.SetStateAction<boolean>>;
  model: string;
  setModel: React.Dispatch<React.SetStateAction<string>>;
  providerName: string;
  setProviderName: React.Dispatch<React.SetStateAction<string>>;
  sessionTurns: number;
  setSessionTurns: React.Dispatch<React.SetStateAction<number>>;
  sessionToolCalls: number;
  setSessionToolCalls: React.Dispatch<React.SetStateAction<number>>;
  lastUsage: PromptTokensCarrier | undefined;
  setLastUsage: React.Dispatch<React.SetStateAction<PromptTokensCarrier | undefined>>;
  estimatedTokens: number | undefined;
  setEstimatedTokens: React.Dispatch<React.SetStateAction<number | undefined>>;
  contextWindow: number;
  setContextWindow: React.Dispatch<React.SetStateAction<number>>;
  permissionRequest: PermissionRequestState | undefined;
  setPermissionRequest: React.Dispatch<React.SetStateAction<PermissionRequestState | undefined>>;
  pendingToolCall: ToolCallSummary | null;
  setPendingToolCall: React.Dispatch<React.SetStateAction<ToolCallSummary | null>>;
  queueLength: number;
  setQueueLength: React.Dispatch<React.SetStateAction<number>>;
  thinking: boolean;
  setThinking: React.Dispatch<React.SetStateAction<boolean>>;
  compacting: { aggressive: boolean } | null;
  setCompacting: React.Dispatch<React.SetStateAction<{ aggressive: boolean } | null>>;
  runningTool: string | null;
  setRunningTool: React.Dispatch<React.SetStateAction<string | null>>;
  activity: string | null;
  setActivity: React.Dispatch<React.SetStateAction<string | null>>;
  streamingText: string;
  setStreamingText: React.Dispatch<React.SetStateAction<string>>;
  gitBranch: string | undefined;
  setGitBranch: React.Dispatch<React.SetStateAction<string | undefined>>;
  gitDirty: boolean | null;
  setGitDirtyState: React.Dispatch<React.SetStateAction<boolean | null>>;
  cwd: string;
  setCwdState: React.Dispatch<React.SetStateAction<string>>;
  emojiMode: boolean;
  setEmojiMode: React.Dispatch<React.SetStateAction<boolean>>;
  userEmoji: string | undefined;
  setUserEmojiState: React.Dispatch<React.SetStateAction<string | undefined>>;
  refs: React.MutableRefObject<RunRefs | null>;
  nextId: () => number;
  addItem: (item: DisplayItem) => void;
  addNotice: (level: NoticeLevel, text: string) => void;
  addNoticeBlock: (lines: { level: NoticeLevel; text: string; bold?: boolean }[]) => void;
  addNoticeBox: (lines: string[], borderColor?: string) => void;
  refreshTokenEstimate: () => void;
  composeSystemPrompt: () => string;
}

export function useAgentLoopState(opts: UseAgentLoopOptions): AgentLoopStateStore {
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [state, setState] = useState<RunState>('idle');
  const [plannedCalls, setPlannedCalls] = useState<ToolCallSummary[]>([]);
  const [planMode, setPlanMode] = useState(opts.planMode ?? false);
  const [model, setModel] = useState(opts.model);
  const [providerName, setProviderName] = useState(opts.provider.name);
  const [sessionTurns, setSessionTurns] = useState(0);
  const [sessionToolCalls, setSessionToolCalls] = useState(0);
  const [lastUsage, setLastUsage] = useState<PromptTokensCarrier | undefined>();
  const [estimatedTokens, setEstimatedTokens] = useState<number | undefined>();
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
  const noticeDiagnostics = createDiagnosticEmitter(
    sessionLogDiagnosticSink(() => refs.current?.sessionLogger),
  );

  function addItem(item: DisplayItem): void {
    setItems(prev => [...prev, item]);
  }
  function addNotice(level: NoticeLevel, text: string): void {
    addItem({ kind: 'notice', id: nextId(), text, level });
    if (level === 'warn') {
      noticeDiagnostics.warning(text, `notice:${level}`);
    } else if (level === 'danger') {
      noticeDiagnostics.error(text, `notice:${level}`);
    }
  }
  function addNoticeBlock(lines: { level: NoticeLevel; text: string; bold?: boolean }[]): void {
    addItem({ kind: 'notice-block', id: nextId(), lines });
    for (const line of lines) {
      if (line.level === 'warn') {
        noticeDiagnostics.warning(line.text, `notice:${line.level}`);
      } else if (line.level === 'danger') {
        noticeDiagnostics.error(line.text, `notice:${line.level}`);
      }
    }
  }
  function addNoticeBox(lines: string[], borderColor?: string): void {
    addItem({ kind: 'notice-box', id: nextId(), lines, ...(borderColor ? { borderColor } : {}) });
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
      scopedProjectInstructions: refs.current.scopedProjectInstructions,
    });
  }

  return {
    items,
    setItems,
    state,
    setState,
    plannedCalls,
    setPlannedCalls,
    planMode,
    setPlanMode,
    model,
    setModel,
    providerName,
    setProviderName,
    sessionTurns,
    setSessionTurns,
    sessionToolCalls,
    setSessionToolCalls,
    lastUsage,
    setLastUsage,
    estimatedTokens,
    setEstimatedTokens,
    contextWindow,
    setContextWindow,
    permissionRequest,
    setPermissionRequest,
    pendingToolCall,
    setPendingToolCall,
    queueLength,
    setQueueLength,
    thinking,
    setThinking,
    compacting,
    setCompacting,
    runningTool,
    setRunningTool,
    activity,
    setActivity,
    streamingText,
    setStreamingText,
    gitBranch,
    setGitBranch,
    gitDirty,
    setGitDirtyState,
    cwd,
    setCwdState,
    emojiMode,
    setEmojiMode,
    userEmoji,
    setUserEmojiState,
    refs,
    nextId,
    addItem,
    addNotice,
    addNoticeBlock,
    addNoticeBox,
    refreshTokenEstimate,
    composeSystemPrompt,
  };
}
