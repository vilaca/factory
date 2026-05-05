import type { Provider, TokenUsage, ToolCallMessage } from '../providers/types.js';
import type { ToolResult } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Conversation } from './conversation.js';
import type { ContextManager } from './context-manager.js';
import type { PermissionManager, PermissionDecision } from '../permissions.js';
import type { FileCache } from './agent/file-cache.js';
import type { ProviderKey, RotationEntry } from './config-types.js';

export type { PermissionDecision };

export type StopReason =
  | 'completed'
  | 'user-abort'
  | 'token-limit'
  | 'error';

export type AgentEvent =
  | { type: 'text-chunk'; content: string }
  | { type: 'text-done'; fullContent: string }
  | { type: 'tool-call-start'; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-call-result'; toolName: string; args: Record<string, unknown>; result: ToolResult }
  | { type: 'tool-call-denied'; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-call-recovered'; count: number; source: 'tag' | 'fence' | 'bare' | 'shell-fence' | 'function-tag' }
  | { type: 'tool-result-imitation-stripped'; count: number }
  | { type: 'auto-retry-injected'; remainingBudget: number; reason: string }
  | { type: 'auto-retry-exhausted' }
  | { type: 'all-denied-halt'; count: number }
  | { type: 'tool-call-corrected'; original: ToolCallMessage; corrected: ToolCallMessage; reason: string }
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
  | { type: 'read-cache-hit'; path: string; afterCompaction: boolean }
  | { type: 'repetition-detected'; line: string; streak: number }
  | { type: 'empty-turn-warning'; completionTokens: number }
  | { type: 'output-cap-reached'; completionTokens: number }
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
  };
  /** Session-level cache of Read fingerprints. Required when experimental.readCache is on. */
  fileCache?: FileCache;
  /** Mutable working-directory holder. Tools resolve relative paths against
   * `.current` and Bash updates it via `cwdAfter`, so `cd` persists across
   * calls within a turn. The agent loop reads it back after the turn to keep
   * RunRefs in sync. Optional — headless callers may omit it and tools fall
   * back to `process.cwd()`. */
  cwdRef?: { current: string };
  /** When set, the runtime rotates among saved keys for the active provider
   *  on rate-limit/auth failures before giving up. */
  rotation?: RotationOptions;
}

export interface RotationOptions {
  /** Saved keys for the active provider, in priority order. */
  keys: ProviderKey[];
  /** Active key id at call start; updated by the runtime as rotation
   *  swaps keys. Pre-populated from RunRefs.activeKeyId. */
  activeKeyId?: string;
  /** Construct a Provider instance bound to the given key's token (and
   *  any per-key extras like Workers AI's accountId). */
  withKey: (key: ProviderKey) => Provider;
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
   *  non-empty. */
  withTuple?: (provider: string, key: ProviderKey) => Provider;

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
