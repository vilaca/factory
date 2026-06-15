import type { Provider, TokenUsage, ToolCallMessage } from '../../providers/types.js';
import type { ExecutedToolResult, ToolHost } from '../../tools/host.js';
import type { Conversation } from '../context/conversation.js';
import type { ContextManager } from '../context/context-manager.js';
import type { PermissionManager, PermissionDecision } from '../../security/permissions.js';
import type { FileCache } from './cache/file-cache.js';
import type { HooksConfig, ProviderKey, RotationEntry } from '../config/types.js';
import type { PathPolicy } from '../../security/paths.js';
import type { EnvPolicy } from '../../security/env.js';
import type { ModelSelection } from '../selection/types.js';

export type { PermissionDecision };

type StopReason = 'completed' | 'user-abort' | 'token-limit' | 'turn-limit' | 'error';

/** Per-session pointer into OpenAI's stored response chain. The agent
 *  loop captures it from the terminal chunk of a /v1/responses turn and
 *  feeds it back via ChatOptions.responsesChain on the next call so the
 *  server reuses prior reasoning tokens instead of re-deriving them.
 *
 *  `provider`, `model`, and `keyId` are validated at use-site so a stale
 *  pointer (left over from a swap that failed to clear it) cannot
 *  corrupt the next call — the worst case is a missed optimization.
 *  `messageCount` is the conversation length captured AFTER the assistant
 *  response was appended; the body builder slices messages[messageCount:]
 *  before mapping to the Responses API `input` array. */
export interface ResponsesChain extends ModelSelection {
  lastResponseId: string;
  messageCount: number;
}

export type AgentEvent =
  | { type: 'text-chunk'; content: string }
  | { type: 'text-done'; fullContent: string }
  | { type: 'tool-call-start'; toolName: string; args: Record<string, unknown> }
  | {
      type: 'tool-call-result';
      toolName: string;
      args: Record<string, unknown>;
      result: ExecutedToolResult;
    }
  | { type: 'tool-call-denied'; toolName: string; args: Record<string, unknown> }
  | {
      type: 'tool-call-recovered';
      count: number;
      source: 'tag' | 'fence' | 'bare' | 'shell-fence' | 'function-tag';
    }
  | { type: 'tool-result-imitation-stripped'; count: number }
  /** The model called the synthetic Respond tool as its terminal action.
   *  The agent loop short-circuits — yields the message as `text-done`,
   *  records a plain assistant message in history, and completes the
   *  turn. This event tells observability that what looks like a normal
   *  `text-done` was actually structured through the Respond pathway
   *  (the small-model reliability trick: keep the model in tool-calling
   *  grammar at all times, never let it choose between "emit text" and
   *  "call a tool"). */
  | { type: 'respond-stripped'; message: string }
  /** Mid-conversation context-pressure signal (Phase 7). Emitted once
   *  per threshold per pressure cycle when usage crosses a configured
   *  fraction of the budget. The agent loop also injects the same
   *  warning text as a transient `user` message into the outbound API
   *  payload — UIs use this event to surface the warning to the human
   *  alongside the model. */
  | { type: 'context-warning'; thresholdPct: number; tokens: number; warning: string }
  /** Phase 5/14: step enforcer flagged a premature-terminal attempt
   *  and injected a tier-escalating nudge into history. Distinct
   *  from the generic `auto-retry-injected` so observability can
   *  count tier-3 events separately (alertable signal). */
  | { type: 'step-nudge'; tier: 1 | 2 | 3; attemptedTool: string; pending: readonly string[] }
  /** Phase 5/14: step enforcer flagged a missing prereq and
   *  injected a corrective nudge into history. */
  | { type: 'prerequisite-nudge'; tool: string; missing: readonly string[] }
  /** Phase 5/14: a tool the StepEnforcer recognizes as a required
   *  step just completed. Useful for "workflow progressing"
   *  visualisations. */
  | { type: 'step-completed'; tool: string }
  | { type: 'auto-retry-injected'; remainingBudget: number; reason: string }
  | { type: 'auto-retry-exhausted' }
  | { type: 'all-denied-halt'; count: number }
  | {
      type: 'tool-call-corrected';
      original: ToolCallMessage;
      corrected: ToolCallMessage;
      reason: string;
    }
  | { type: 'tool-call-corrector-aborted'; reason: string }
  | { type: 'tool-call-planned'; toolName: string; args: Record<string, unknown> }
  | {
      type: 'permission-request';
      toolName: string;
      args: Record<string, unknown>;
      respond: (decision: PermissionDecision) => void;
    }
  | { type: 'compaction-start'; aggressive: boolean }
  /** Final compaction outcome for this turn. `aggressive` is kept for
   *  back-compat with existing TUI surfaces (true iff the LLM-summary
   *  emergency path tightened the recency window). `phase` is the
   *  reliability-stack escalation level actually reached:
   *    0 = no compaction performed (no event would fire)
   *    1 = nudges dropped + tool_results truncated (deterministic)
   *    2 = + tool_results dropped (deterministic)
   *    3 = + reasoning/text_response dropped (deterministic, last resort)
   *    4 = LLM-summary emergency fallback ran
   *  Phases 1–3 don't call the model; only phase 4 does. */
  | {
      type: 'compaction';
      oldMessages: number;
      newMessages: number;
      aggressive: boolean;
      phase: 0 | 1 | 2 | 3 | 4;
    }
  | { type: 'bash-dedup-nudge'; recentCommands: string[] }
  | { type: 'hook-veto'; event: string; toolName: string; errorMessage?: string }
  | { type: 'hook-error'; event: string; error: string }
  | { type: 'hook-fired'; event: string; hookCommand: string; notice?: string }
  | { type: 'read-cache-hit'; path: string; afterCompaction: boolean }
  /** Harness discovered scoped instruction files and queued synthetic Read calls.
   * `files` are newly discovered absolute paths for this refresh pass. */
  | { type: 'scoped-project-instructions-updated'; files: string[] }
  | { type: 'repetition-detected'; line: string; streak: number }
  | { type: 'empty-turn-warning'; completionTokens: number }
  | { type: 'output-cap-reached'; completionTokens: number }
  /** Provider terminated the turn because the response was blocked or
   *  refused — distinct from a natural stop. `reason` carries the raw
   *  provider-side `finish_reason`/`stop_reason` for forensics:
   *  - OpenAI: `content_filter` (output blocked by policy classifier).
   *  - Anthropic: `refusal` (Claude declined the request mid-stream, 4.x).
   *  - Other providers (Ollama, Gemini, Mistral) don't currently emit
   *    a refusal/filter reason; the event will not fire for them. Wire a
   *    new mapping here when one starts. */
  | { type: 'output-blocked'; reason: string }
  | { type: 'pre-turn-stats'; tokenEstimate: number; messageCount: number; percentOfWindow: number }
  | {
      type: 'key-rotation';
      provider: string;
      from: { keyId: string; fingerprint: string; label?: string } | null;
      to: { keyId: string; fingerprint: string; label?: string };
      reason: 'rate-limit' | 'auth';
    }
  | { type: 'key-rotation-exhausted'; provider: string; reason: 'rate-limit' | 'auth' }
  | {
      type: 'tuple-rotation';
      from: { provider: string; model: string };
      to: { provider: string; model: string };
      reason: 'rate-limit' | 'auth';
    }
  | { type: 'tuple-rotation-exhausted'; reason: 'rate-limit' | 'auth' }
  | {
      /** Emitted before a same-key retry sleep. Used by the status bar to
       *  show what the agent is waiting on, and by the session log for
       *  flake postmortems. The retry hasn't happened yet — `delayMs` is
       *  what's about to be slept before the next attempt fires. */
      type: 'provider-retry';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: 'network' | 'server-error' | 'rate-limit' | 'timeout';
    }
  | { type: 'turn-complete'; stopReason: StopReason; turnsUsed: number; usage?: TokenUsage }
  | { type: 'error'; error: Error };

export interface AgentOptions {
  provider: Provider;
  model: string;
  conversation: Conversation;
  permissions: PermissionManager;
  toolRegistry: ToolHost;
  contextManager?: ContextManager;
  signal?: AbortSignal;
  useTextToolFallback?: boolean;
  nativeToolSupport?: boolean;
  planMode?: boolean;
  /** When true (default), failed tool calls trigger one corrector LLM pass. */
  enableCorrector?: boolean;
  /** Optional experimental flags. None of these change default behavior. */
  experimental?: {
    bashDedup?: boolean;
    readCache?: boolean;
    hooks?: boolean;
  };
  /** Session-level cache of Read fingerprints. Required when experimental.readCache is on. */
  fileCache?: FileCache;
  /** Mutable working-directory holder. Tools resolve relative paths against
   * `.current` and Bash updates it via `cwdAfter`, so `cd` persists across
   * calls within a turn. The agent loop reads it back after the turn to keep
   * RunRefs in sync. Also used by hook discovery for project-local hooks
   * under `<cwdRef.current>/.factory/hooks/`. Optional — headless callers
   * may omit it and tools fall back to `process.cwd()`. */
  cwdRef?: { current: string };
  /** Path-policy deny extensions. Built-in deny list (~/.ssh, /etc/shadow,
   *  …) always applies; this is for user-supplied additions. The loop
   *  forwards it through ToolLoopContext to each tool's ToolContext so
   *  Read/Write/Edit/Grep/Glob can hard-deny without consulting any
   *  process-global state. */
  pathPolicy?: PathPolicy;
  /** Env-policy allow extensions used by Bash to scrub the spawned shell's
   *  environment. Same plumbing rules as pathPolicy. */
  envPolicy?: EnvPolicy;
  /** When set, the runtime rotates among saved keys for the active provider
   *  on rate-limit/auth failures before giving up. */
  rotation?: RotationOptions;
  /** Mutable holder for the active OpenAI Responses-API chain pointer.
   *  Read before each callModel; updated after a successful capture. The
   *  host (TUI / headless) owns the storage so chain state survives
   *  between turns within a session. Optional — providers that don't speak
   *  the Responses API leave it absent and the runtime no-ops. */
  responsesChainRef?: {
    get(): ResponsesChain | undefined;
    set(value: ResponsesChain | undefined): void;
  };
  /** Optional sink invoked when a hook command writes to stderr; the host
   *  wires this to the session log. */
  onHookStderr?: (command: string, chunk: string) => void;
  /** Optional sink invoked with errors raised while running a hook
   *  (timeout, malformed JSON, non-zero exit, spawn failure). */
  onHookError?: (event: string, error: string) => void;
  /** Resolved hook config; absent or empty when no hooks are configured.
   *  Read from `config.agent.hooks` at session start. */
  hooksConfig?: HooksConfig;
  /** Optional callback fired before each tool action so hosts can refresh
   *  runtime-scoped project instructions (AGENTS.md/CLAUDE.md/etc) for the
   *  directory being worked. Returning `changed=true` emits a
   *  `scoped-project-instructions-updated` event. */
  onToolCallStart?: (info: {
    toolName: string;
    args: Record<string, unknown>;
    cwd: string;
  }) => Promise<{ changed: boolean; newFiles: string[] } | null>;
  /** Optional callback fired after successful tool-call results so hosts can
   *  pick up instruction-file edits created by that tool execution.
   *  Returning `changed=true` emits a
   *  `scoped-project-instructions-updated` event. */
  onSuccessfulToolCall?: (info: {
    toolName: string;
    args: Record<string, unknown>;
    cwd: string;
  }) => Promise<{ changed: boolean; newFiles: string[] } | null>;
  /** Reliability-stack step enforcement (Phase 5). When `requiredSteps`
   *  is non-empty, the agent loop installs a StepEnforcer that blocks
   *  premature terminal calls with a 3-tier escalating nudge and
   *  enforces declared `prerequisites` on registered tools. Default
   *  `[]` keeps the feature dormant for the general TUI / headless
   *  path; opted in by scripted callers (skills, future workflows) that
   *  know the canonical ordering. */
  requiredSteps?: readonly string[];
  /** Reliability-stack terminal tool names. When the model attempts
   *  one of these and not every `requiredSteps` entry has executed,
   *  the enforcer emits a step nudge. Default `[]` (no terminals → no
   *  premature-terminal check fires). */
  terminalTools?: readonly string[];
}

export interface RotationOptions {
  /** Saved keys for the active provider, in priority order. */
  keys: ProviderKey[];
  /** Active key id at call start; updated by the runtime as rotation
   *  swaps keys. Pre-populated from RunRefs.activeKeyId. */
  activeKeyId?: string;
  /** Construct a Provider instance bound to the given key's token (and
   *  any per-key extras like Workers AI's accountId). Async because the
   *  host primes the provider before returning it — the rotated
   *  provider is consumed by `chat()` / `chatNoStream()` and (via the
   *  host's `onProviderChange`) becomes the next turn's
   *  `RunRefs.provider`, so it must be primed for the same reasons
   *  swap.ts primes a swapped provider (cf880ed). */
  withKey: (key: ProviderKey) => Promise<Provider>;
  /** Called whenever rotation swaps keys so the host can keep RunRefs
   *  in sync. Optional — tests may omit it. */
  onActiveKeyChange?: (keyId: string) => void;
  /** Called once per turn when rotation has produced a new Provider
   *  instance. The host updates RunRefs.provider so subsequent turns
   *  start from the rotated provider, not the stale one. */
  onProviderChange?: (next: Provider) => void;
  /** Called once per turn when tier-2 rotation has swapped to a new
   *  (provider, model) pair. The host updates RunRefs.model. */
  onModelChange?: (model: string) => void;
  /** In-memory log of recent failures, keyed by `keyId`. Used to
   *  deprioritise keys that 429'd in the last few minutes. The runtime
   *  reads + writes this map; the host owns its lifetime. */
  failureLog?: Map<string, number>;
  /** Optional async hook returning `keyId → last-cache-read timestamp (ms)`
   *  for the active provider's keys. Drives the rotation tiebreaker —
   *  among healthy keys, prefer the one whose prompt cache is still warm.
   *  Hosts source this from `key-stats.getWarmthLog`. Tests omit it. */
  getWarmthLog?: () => Promise<ReadonlyMap<string, number>>;

  // ─── Tier 2 (chain rotation) ─────────────────────────────────────────
  /** When false, tier 2 is a no-op even when the chain has entries. */
  modelsEnabled?: boolean;
  /** Fallback chain to walk after tier 1 exhausts for the active tuple.
   *  Entries are tried in order; entries already tried in this call are
   *  skipped. Empty/undefined means tier 2 won't fire. */
  chain?: RotationEntry[];
  /** Load saved keys for a different provider when tier 2 advances.
   *  Required when `chain` is non-empty. */
  loadKeysForProvider?: (provider: string) => Promise<ProviderKey[]>;
  /** Build a Provider instance for an arbitrary `(provider, key)` pair —
   *  used when tier 2 hops between providers. Required when `chain` is
   *  non-empty. Async because the host primes the provider before
   *  returning it (same rationale as `withKey`). */
  withTuple?: (provider: string, key: ProviderKey) => Promise<Provider>;

  /**
   * Last-chance hook called after both tiers exhaust (or when the chain is
   * empty). The host typically prompts the user — yes opens the picker in
   * select-rotation-entry mode, no sets a session-level decline flag and
   * returns `null`. When the host returns a {provider, model} entry, the
   * runtime treats it as a one-shot chain advance: persists the entry,
   * builds a fresh provider, and retries.
   */
  promptForFallback?: (context: {
    provider: string;
    model: string;
    reason: 'rate-limit' | 'auth';
  }) => Promise<RotationEntry | null>;
}
