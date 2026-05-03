import type { McpServerConfig } from '../mcp/types.js';

export type GoogleAiStudioAuthMode = 'api-key' | 'oauth';

export interface AgentConfig {
  maxTurns?: number;
  compactionThreshold?: number;
  recencyWindow?: number;
  /** Hard ceiling per turn. When set, the runtime aborts the agent run after
   * this many seconds. Default: unset (no timeout). */
  turnTimeoutSec?: number;
  experimental?: ExperimentalFlags;
}

export interface ExperimentalFlags {
  /** Detect repeated near-identical Bash commands and inject a corrective nudge. */
  bashDedup?: boolean;
  /** Cache file mtime/hash on Read so repeat reads can short-circuit, and
   * pass the cache fingerprints into compaction summaries so the agent can
   * confirm "still unchanged" after history is summarized. */
  readCache?: boolean;
  /** Add a system-prompt hint to prefer cloc/scc for line-counting tasks. */
  lineCountHint?: boolean;
}

export const EXPERIMENTAL_FLAG_KEYS = ['bashDedup', 'readCache', 'lineCountHint'] as const;
export type ExperimentalFlagKey = typeof EXPERIMENTAL_FLAG_KEYS[number];

export interface PermissionConfig {
  allowAll?: string[];
}

export interface McpConfig {
  servers?: McpServerConfig[];
}

export interface Config {
  provider?: string;
  model?: string;
  host?: string;
  token?: string;
  huggingfaceToken?: string;
  anthropicToken?: string;
  copilotToken?: string;
  githubToken?: string;
  openrouterToken?: string;
  vercelToken?: string;
  opencodeZenToken?: string;
  googleAiStudioToken?: string;
  googleAiStudioAuthMode?: GoogleAiStudioAuthMode;
  mistralToken?: string;
  codestralToken?: string;
  cerebrasToken?: string;
  groqToken?: string;
  cohereToken?: string;
  workersAiToken?: string;
  workersAiAccountId?: string;
  agent?: AgentConfig;
  permissions?: PermissionConfig;
  mcp?: McpConfig;
}
