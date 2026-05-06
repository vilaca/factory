import type { McpServerConfig } from '../mcp/types.js';

export type GoogleAiStudioAuthMode = 'api-key' | 'oauth';

export interface AgentConfig {
  compactionThreshold?: number;
  recencyWindow?: number;
  /** Hard ceiling per turn. When set, the runtime aborts the agent run after
   * this many seconds. Default: unset (no timeout). */
  turnTimeoutSec?: number;
  experimental?: ExperimentalFlags;
  /** Automatic rotation across saved keys (tier 1) and a chain of
   *  `(provider, model)` entries (tier 2) when the active selection
   *  returns 429/401/403. Edited via `/rotate` and `--rotate`. */
  rotation?: RotationConfig;
}

/** One step in a rotation chain — provider + model. */
export interface RotationEntry {
  provider: string;
  model: string;
}

export interface RotationConfig {
  /** Tier 1: rotate among saved keys for the active (provider, model)
   *  before advancing to the chain. Default: true. */
  keys?: boolean;
  /** Tier 2: walk the rotation chain when keys are exhausted.
   *  Default: true. */
  models?: boolean;
  /** Fallback chain used when the current selection has no specific
   *  override below. */
  default?: RotationEntry[];
  /** Per-(provider, model) override chains. Key shape: `<provider>:<model>`,
   *  matched against the active selection at rotation time. */
  overrides?: Record<string, RotationEntry[]>;
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

/**
 * One saved credential for a provider. Pre-multi-key configs migrate their
 * single `<provider>Token` field into a one-element array on first save
 * under the new schema; the legacy field is left in place for downgrade
 * safety. The picker shows last-4 + optional label to identify the entry.
 */
export interface ProviderKey {
  /** Stable id, minted via crypto.randomUUID(). Recent-session payloads
   *  and the picker reference this when targeting a specific key. */
  id: string;
  /** Optional, user-supplied. Distinct keys can share a label. */
  label?: string;
  /** The secret. Always full-length on disk; UI shows last-4 only. */
  token: string;
  /** ISO timestamp (when the entry was added). */
  createdAt: string;
  /** Provider-specific extras. WorkersAI: `{ accountId }`. Reserved for
   *  future per-key fields without growing the top-level schema. */
  extras?: Record<string, string>;
}

/** Keyed by canonical provider name (the value side of PROVIDER_ALIASES). */
export interface ConfigKeys {
  [providerName: string]: ProviderKey[];
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
  /** Multi-key credential store. Source of truth once migrated; legacy
   *  `*Token` fields above remain readable as a fallback. */
  keys?: ConfigKeys;
  agent?: AgentConfig;
  permissions?: PermissionConfig;
  mcp?: McpConfig;
}
