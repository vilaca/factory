import type { ModelSelection } from '../../selection/types.js';

/** Re-exported for backwards-compat — the canonical declaration lives in
 *  `src/core/selection/types.ts` to avoid a session-log ↔ selection
 *  type-level cycle (RecentSession extends ModelSelection, and the
 *  picker carries the status badge as part of the selection record). */
export type { SessionErrorStatus } from '../../selection/types.js';

export interface SessionStartMeta extends ModelSelection {
  cwd: string;
  experimental?: Record<string, boolean>;
  turnTimeoutSec?: number;
  appVersion?: string;
  buildTimestamp?: string;
  mcp?: { servers: string[]; toolCount: number };
  gitBranch?: string;
  gitDirty?: boolean | null;
}

/** Alias of the canonical ModelSelection record — kept named so the
 *  read sites (getLastSessionSelection) document their intent
 *  (resuming the most recent session). New fields on ModelSelection
 *  flow through here automatically. */
export type LastSessionSelection = ModelSelection;

/** A row in the recent-sessions list. Carries a ModelSelection plus
 *  the `startedAt` timestamp that the picker uses to sort. */
export interface RecentSession extends ModelSelection {
  startedAt: string;
}

export interface ProviderAuthMeta {
  provider: string;
  action: string;
  outcome: 'started' | 'success' | 'error' | 'skipped';
  detail?: string;
}

export interface ModelRequestMeta {
  provider: string;
  model: string;
  /** Which caller issued the request. */
  source: 'main' | 'compaction' | 'corrector' | 'subagent';
  /** Streaming (`chat`) vs. one-shot (`chatNoStream`). */
  streaming: boolean;
  /** Full outgoing message list — system prompt, user turns, tool results,
   *  assistant turns — exactly as handed to the provider. */
  messages: unknown[];
  /** Tool definitions sent alongside, if any. */
  tools?: unknown[];
  /** Whitelisted ChatOptions fields useful for replay (temperature, maxTokens,
   *  responsesChain, …). The shape is provider-shared so we widen to `unknown`. */
  options?: Record<string, unknown>;
}

export interface SessionLoggerOpts {
  /** Called once, after the first write failure (and after the default
   *  stderr surface fires). Strict-logging callers use this to escalate —
   *  e.g. `process.exit` from headless mode when --strict-log is set. */
  onWriteError?: (err: unknown) => void;
}
