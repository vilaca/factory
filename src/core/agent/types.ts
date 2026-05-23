import type { Provider, TokenUsage, ToolCallMessage } from '../../providers/types.js';
import type { ToolResult } from '../../tools/types.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { Conversation } from '../context/conversation.js';
import type { ContextManager } from '../context/context-manager.js';
import type { PermissionManager, PermissionDecision } from '../../security/permissions.js';
import type { FileCache } from './cache/file-cache.js';
import type { HooksConfig, ProviderKey, RotationEntry } from '../config/types.js';
import type { PathPolicy } from '../../security/paths.js';
import type { EnvPolicy } from '../../security/env.js';

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
export interface ResponsesChain {
  lastResponseId: string;
  messageCount: number;
  provider: string;
  model: string;
  keyId?: string;
}

export type AgentEvent =
  | { type: 'text-chunk'; content: string }
  | { type: 'text-done'; fullContent: string }
  | { type: 'tool-call-start'; toolName: string; args: Record<string, unknown> }
  | {
      type: 'tool-call-result';
      toolName: string;
      args: Record<string, unknown>;
      result: ToolResult;
    }
  | { type: 'tool-call-denied'; toolName: string; args: Record<string, unknown> }
  | {
      type: 'tool-call-recovered';
      count: number;
      source: 'tag' | 'fence' | 'bare' | 'shell-fence' | 'function-tag';
    }
  | { type: 'tool-result-imitation-stripped'; count: number }
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
  | { type: 'compaction'; oldMessages: number; newMessages: number; aggressive: boolean }
  | { type: 'bash-dedup-nudge'; recentCommands: string[] }
  | { type: 'hook-veto'; event: string; toolName: string; errorMessage?: string }
  | { type: 'hook-error'; event: string; error: string }
  | { type: 'hook-fired'; event: string; hookCommand: string; notice?: string }
  | { type: 'read-cache-hit'; path: string; afterCompaction: boolean }
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
  toolRegistry: ToolRegistry;
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
