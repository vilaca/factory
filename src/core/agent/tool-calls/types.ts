import type { Provider } from '../../../providers/types.js';
import type { HooksConfig } from '../../config/types.js';
import type { ToolRegistry } from '../../../tools/registry.js';
import type { PathPolicy } from '../../../security/paths.js';
import type { EnvPolicy } from '../../../security/env.js';
import type { Conversation } from '../../context/conversation.js';
import type { PermissionManager } from '../../../security/permissions.js';
import type { BashDedupTracker } from './bash-dedup.js';
import type { FileCache } from '../cache/file-cache.js';
import type { AsyncMutex } from './async-mutex.js';
import type { StepEnforcer } from '../step-enforcer.js';

export interface ToolLoopContext {
  conversation: Conversation;
  permissions: PermissionManager;
  toolRegistry: ToolRegistry;
  signal: AbortSignal | undefined;
  useUserResultFraming: boolean;
  planMode: boolean;
  enableCorrector: boolean;
  bashDedup?: BashDedupTracker;
  fileCache?: FileCache;
  provider: Provider;
  model: string;
  userInput: string;
  /** Mutable cwd holder for the per-tab working directory. Tools resolve
   * relative paths against `.current`, and Bash updates it via `cwdAfter` so
   * `cd` persists across calls within a turn. The agent loop syncs this back
   * to RunRefs after the loop completes. Optional so headless callers can
   * skip it. */
  cwdRef?: { current: string };
  /** Path-policy deny extensions (built-in deny list always applies). The
   * loop forwards this verbatim to each tool's ToolContext. */
  pathPolicy?: PathPolicy;
  /** Env-policy allow extensions for Bash. Same plumbing as pathPolicy. */
  envPolicy?: EnvPolicy;
  hooksEnabled?: boolean;
  hooksConfig?: HooksConfig;
  onHookStderr?: (command: string, chunk: string) => void;
  onHookError?: (event: string, error: string) => void;
  /** When set, executeToolCall serializes its `permission-request` yield
   *  through this mutex. The parallel-Delegate batch path uses it so that
   *  N concurrent pipelines never produce N overlapping prompts — the UI
   *  was built assuming one prompt at a time, and a shared mutex preserves
   *  that invariant without forcing execution itself to serialize. Other
   *  call sites leave this undefined and pay no overhead. */
  permissionMutex?: AsyncMutex;
  /** Reliability-stack step enforcer. When set, the tool-execution
   *  pipeline calls `enforcer.record(name, args)` after a successful
   *  call so the tracker knows that required step was completed and
   *  the prereq lookups for later tools have the matching args.
   *  Optional — callers without `requiredSteps` / `terminalTools` /
   *  prereqs leave this undefined and the recording is a no-op. */
  stepEnforcer?: StepEnforcer;
}
