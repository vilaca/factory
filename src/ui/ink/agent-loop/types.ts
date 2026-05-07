import type { AgentConfig, BashRuleConfig, ExperimentalFlags, HooksConfig, RotationEntry } from '../../../core/config-types.js';
import type { Conversation } from '../../../core/conversation.js';
import type { ContextManager } from '../../../core/context-manager.js';
import type { FileCache } from '../../../core/agent/file-cache.js';
import type { PermissionManager } from '../../../permissions.js';
import type { Provider } from '../../../providers/types.js';
import type { SessionLogger } from '../../../core/session-log.js';
import type { SkillsRegistry } from '../../../core/skills/index.js';
import type { PathPolicy } from '../../../security/paths.js';
import type { EnvPolicy } from '../../../security/env.js';
import type { DisplayItem, ToolCallSummary } from '../types.js';

export type RunState = 'idle' | 'running' | 'awaiting-permission';
export type NoticeLevel = 'info' | 'warn' | 'danger' | 'cyan';
export type { PermissionDecision } from '../../../permissions.js';
import type { PermissionDecision } from '../../../permissions.js';

export interface PermissionRequestState {
  toolName: string;
  args: Record<string, unknown>;
  resolve: (d: PermissionDecision) => void;
}

/** Live rotation state owned by RunRefs; mirrors `agent.rotation` from the
 *  config but mutable for `/rotate`. The runtime reads this on each call. */
interface RotationRefs {
  keysEnabled: boolean;
  modelsEnabled: boolean;
  default: RotationEntry[];
  overrides: Record<string, RotationEntry[]>;
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
  /** Per-tab provider. Seeded from the launch provider; can be swapped via
   * `/provider <name>`. Two tabs can hold the same Provider instance — they
   * are stateless per call. */
  provider: Provider;
  model: string;
  /** The (provider, model) the user is "homed" on for this tab. Captured at
   *  session start and updated only by user-driven swaps (setProviderByName /
   *  setModelByName). Tier-2 rotation does *not* touch this — that's how
   *  `/rotate refresh` knows where to return. */
  primary: { provider: string; model: string };
  useTextToolFallback: boolean;
  nativeToolSupport: boolean;
  planMode: boolean;
  enableCorrector: boolean;
  experimental: ExperimentalFlags;
  /** Configured hook commands keyed by event. Cloned from agent.hooks at
   *  session init. Read by the agent loop and by the `/hooks` slash. */
  hooksConfig?: HooksConfig;
  /** Per-tab rotation snapshot, mutated by `/rotate`. Read by the runtime
   *  (commits A + B) on every provider call to decide which keys / chain
   *  entries are eligible. */
  rotation: RotationRefs;
  /** Key id of the credential the active provider was constructed with.
   *  Updated by setProviderByName, by resume-from-recent at startup, and
   *  by the rotation runtime after a key swap. Undefined when the active
   *  token didn't come from the multi-key store (CLI override, env var). */
  activeKeyId?: string;
  /** Per-tab in-memory failure log keyed by `keyId`. The rotation runtime
   *  reads + writes; reset on session restart. */
  keyFailureLog: Map<string, number>;
  /** Set to true when the user declines the "set up a fallback?" prompt.
   *  Subsequent rate-limit failures bypass the prompt for the rest of the
   *  session. Cleared when the user opens the picker via /pick. */
  rotationPromptDeclined: boolean;
  /** UI bridge for the rotation prompt + fallback picker dance. Called by
   *  the rotation runtime after both tiers exhaust; returns the chosen
   *  entry or `null` if the user declined / cancelled. Set by Session.tsx
   *  on mount; left undefined for headless callers. */
  requestFallback?: (context: {
    provider: string;
    model: string;
    reason: 'rate-limit' | 'auth';
  }) => Promise<RotationEntry | null>;
  gitBranch: string | undefined;
  gitDirty: boolean | null;
  /** Per-tab working directory. Tools resolve relative paths against this and
   * spawn shells with this as their cwd. We never call process.chdir(), since
   * concurrent tabs would race the global cwd. Updated by `cd` in Bash and by
   * the `/cwd` slash command. */
  cwd: string;
  lastSubstantivePrompt: string | null;
  replayCounts: Map<string, number>;
  tokenLimitReplayCounts: Map<string, number>;
  inputQueue: string[];
  historyIndex: number;
  historyDraft: string;
  /** Optional skills registry, present only when experimental.skills is on. */
  skills?: SkillsRegistry;
  /** Path / env security policies. Snapshotted from UseAgentLoopOptions at
   *  init so per-tab tools and hooks use the same scrubbed deny lists. */
  pathPolicy: PathPolicy;
  envPolicy: EnvPolicy;
}

export interface UseAgentLoopOptions {
  model: string;
  systemPrompt: string;
  provider: Provider;
  /** Id of the multi-key-store entry the launch provider was built with.
   *  Seeds RunRefs.activeKeyId so per-key stats (recordSuccess /
   *  recordFailure / recordTokenUsage) attribute correctly from turn 1.
   *  Undefined when the token came from a CLI override or env var. */
  keyId?: string;
  agentConfig?: AgentConfig;
  autoAllowTools?: string[];
  bashRules?: BashRuleConfig[];
  useTextToolFallback?: boolean;
  nativeToolSupport?: boolean;
  enableSessionLog?: boolean;
  /** When true, session-log failures (init or first write) terminate the
   *  process with a dedicated exit code. Off by default. Wired from
   *  --strict-log; meant for audit-grade workloads (CI, scripted runs). */
  strictLogging?: boolean;
  planMode?: boolean;
  enableCorrector?: boolean;
  mcpInfo?: { servers: string[]; toolCount: number };
  gitBranch?: string;
  gitDirty?: boolean | null;
  validationWarning?: string;
  /** Per-process security policies. Threaded in from index.ts; the loop
   *  snapshots them onto each tab's RunRefs. */
  pathPolicy?: PathPolicy;
  envPolicy?: EnvPolicy;
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
  /** In-flight tool call rendered in the dynamic region until result/denial
   * resolves. Then it's committed to items[] (and Static) as a single
   * tool-call entry with the right status — so the user sees one panel that
   * morphs from running to ok/denied, instead of a separate denial panel. */
  pendingToolCall: ToolCallSummary | null;
  plannedCalls: ToolCallSummary[];
  planMode: boolean;
  /** Display-name of the active provider, surfaced in the StatusBar so it
   * follows the active tab when the user runs `/provider`. */
  providerName: string;
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
  /** Per-tab working directory, surfaced in the StatusBar. Updated by /cwd
   * and by Bash when a command changes $PWD via `cd`. */
  cwd: string;
  /** Emoji mode toggle — when on, ⏺ becomes 🤖 and > becomes 🧑🏻‍💻. */
  emojiMode: boolean;
  /** Custom user emoji set via `/emoji <glyph>`. Falls back to 🧑🏻‍💻 when
   *  undefined. Only applied while `emojiMode` is on. */
  userEmoji: string | undefined;
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
  setCwd(target: string): void;
  /** Swap to another provider by name. The model can be set in one shot via
   * "providerName:modelName" — useful so the user doesn't end up on a
   * provider whose default model is invalid. */
  setProviderByName(name: string, model?: string, keyId?: string): Promise<void>;
  recordHistory(text: string): void;
  historyUp(currentInput: string): string | null;
  historyDown(): string | null;
  addNotice(level: NoticeLevel, text: string): void;
  addNoticeBlock(lines: { level: NoticeLevel; text: string; bold?: boolean }[]): void;
  setIdle(): void;
  toggleEmojiMode(): void;
  /** Set the user-prompt emoji via `/emoji <glyph>`. Trimmed; empty input
   *  is rejected with a usage notice. Side effect: turns emoji mode on. */
  setUserEmoji(emoji: string): void;
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
  setLastUsage(u: {
    totalTokens?: number;
    completionTokens?: number;
    cachedPromptTokens?: number;
    cacheCreationTokens?: number;
    promptTokens?: number;
  } | undefined): void;
  setPermissionRequest(r: PermissionRequestState | undefined): void;
  setPendingToolCall(v: ToolCallSummary | null): void;
  setPlannedCalls(updater: (prev: ToolCallSummary[]) => ToolCallSummary[]): void;
  /** Snapshot of plannedCalls used for the dedup check inside the
   * tool-call-planned handler. The orchestrator returns the value
   * captured at the start of the current run so behavior matches the
   * pre-refactor closure capture. */
  getPlannedCalls(): ToolCallSummary[];
}
