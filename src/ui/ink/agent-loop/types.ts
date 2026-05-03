import type { AgentConfig, ExperimentalFlags } from '../../../core/config-types.js';
import type { Conversation } from '../../../core/conversation.js';
import type { ContextManager } from '../../../core/context-manager.js';
import type { FileCache } from '../../../core/agent/file-cache.js';
import type { PermissionManager } from '../../../permissions.js';
import type { Provider } from '../../../providers/types.js';
import type { SessionLogger } from '../../../core/session-log.js';
import type { DisplayItem, ToolCallSummary } from '../types.js';

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

/**
 * Dependencies that the extracted helpers (event-handler, run-loop,
 * git-state) need from the orchestrator hook. The hook builds one of
 * these per render so that closure semantics match the pre-refactor code.
 */
export interface AgentLoopDeps {
  refs: { current: RunRefs | null };
  provider: Provider;
  agentConfig?: AgentConfig;
  addItem(item: DisplayItem): void;
  addNotice(level: NoticeLevel, text: string): void;
  nextId(): number;
  refreshTokenEstimate(): void;
  composeSystemPrompt(): string;
  setState(s: RunState): void;
  setThinking(b: boolean): void;
  setRunningTool(s: string | null): void;
  setStreamingText(s: string): void;
  setCompacting(c: { aggressive: boolean } | null): void;
  setSessionTurns(updater: (n: number) => number): void;
  setSessionToolCalls(updater: (n: number) => number): void;
  setLastUsage(u: { totalTokens?: number } | undefined): void;
  setPermissionRequest(r: PermissionRequestState | undefined): void;
  setPlannedCalls(updater: (prev: ToolCallSummary[]) => ToolCallSummary[]): void;
  /** Snapshot of plannedCalls used for the dedup check inside the
   * tool-call-planned handler. The orchestrator returns the value
   * captured at the start of the current run so behavior matches the
   * pre-refactor closure capture. */
  getPlannedCalls(): ToolCallSummary[];
}
