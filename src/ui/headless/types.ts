import type { Provider } from '../../providers/types.js';
import type { AgentConfig, BashRuleConfig } from '../../core/config/types.js';
import type { PathPolicy } from '../../security/paths.js';
import type { EnvPolicy } from '../../security/env.js';
import type { ToolRegistry } from '../../tools/registry.js';

export interface HeadlessOptions {
  model: string;
  systemPrompt: string;
  provider: Provider;
  /** Per-session tool registry. Constructed in src/index.ts (with MCP
   *  and subagent tools registered into it) and passed in via
   *  appOptions. Replaces the previous process-global `defaultRegistry`
   *  import so a future multi-session daemon can hand each headless
   *  invocation a distinct tool set. */
  toolRegistry: ToolRegistry;
  agentConfig?: AgentConfig;
  autoAllowTools?: string[];
  bashRules?: BashRuleConfig[];
  useTextToolFallback?: boolean;
  nativeToolSupport?: boolean;
  enableSessionLog?: boolean;
  /** When true, session-log failures (init or first write) terminate the run
   *  with a dedicated exit code. For audit-grade workloads where a missing
   *  log is unacceptable. Off by default — logging stays best-effort. */
  strictLogging?: boolean;
  planMode?: boolean;
  enableCorrector?: boolean;
  mcpInfo?: { servers: string[]; toolCount: number };
  gitBranch?: string;
  gitDirty?: boolean | null;
  /** Startup instruction files loaded into the base prompt (currently .factory/INSTRUCTIONS.md). */
  loadedFiles?: Set<string>;
  /** Path / env security policies. Threaded in from index.ts (which loads
   *  them from config). Snapshotting them here means tests and parallel
   *  callers can vary policy per run instead of mutating process state. */
  pathPolicy?: PathPolicy;
  envPolicy?: EnvPolicy;
  /** Compaction-target override from --compaction-model. When unset, the
   *  compaction summary call routes to the primary (provider, model) —
   *  this matches the spec's "if --compaction-model NOT set use the
   *  primary provider/model for compaction" rule. When set with a
   *  cross-provider tuple, the resolver instantiates the target
   *  provider on demand the same way swap.ts does. */
  compactionModel?: { providerName: string; model: string };
}

export interface HeadlessRunState {
  exitCode: number;
  permissionDeniedTool: string | undefined;
}
