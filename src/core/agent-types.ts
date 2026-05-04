import type { Provider, TokenUsage, ToolCallMessage } from '../providers/types.js';
import type { ToolResult } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Conversation } from './conversation.js';
import type { ContextManager } from './context-manager.js';
import type { PermissionManager, PermissionDecision } from '../permissions.js';
import type { FileCache } from './agent/file-cache.js';

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
}
