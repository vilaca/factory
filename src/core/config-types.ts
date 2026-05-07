import type { McpServerConfig } from '../mcp/types.js';

export type GoogleAiStudioAuthMode = 'api-key' | 'oauth';

export interface AgentConfig {
  compactionThreshold?: number;
  recencyWindow?: number;
  /** Soft token budget for the recency window during compaction. Whichever
   * is larger — `recencyWindow` (count floor) or as many trailing messages
   * as fit under this budget — wins. Default 4000. */
  recencyTokens?: number;
  /** Hard ceiling per turn. When set, the runtime aborts the agent run after
   * this many seconds. Default: unset (no timeout). */
  turnTimeoutSec?: number;
  /** Hard ceiling per tool result, as approximate tokens (≈4 chars/token).
   * Tool results larger than this are stored elided at insertion time —
   * see Conversation.addToolResult. Default 6000. */
  maxToolResultTokens?: number;
  /** Tool results from turns older than this many turns are eligible for
   * aging (see ContextManager.ageOldToolResults). Default 6. */
  toolResultAgingTurns?: number;
  experimental?: ExperimentalFlags;
  /** Automatic rotation across saved keys (tier 1) and a chain of
   *  `(provider, model)` entries (tier 2) when the active selection
   *  returns 429/401/403. Edited via `/rotate` and `--rotate`. */
  rotation?: RotationConfig;
  /** WebFetch tool configuration. Pre-seeded `allowlist` hostnames bypass
   *  the per-fetch user prompt; useful for headless runs (where there is
   *  no UI to prompt) and for trusted documentation domains the user
   *  doesn't want to whitelist by hand each session. */
  web?: WebConfig;
  /** Lifecycle hook commands keyed by event. Each entry is `{matcher?,
   *  command, timeoutMs?}`. `command` runs via `sh -c` with the project
   *  cwd; the JSON event payload arrives on stdin and the hook may write
   *  a JSON object back on stdout. See README "Hooks". */
  hooks?: HooksConfig;
}

export interface HookEntry {
  /** Shell-glob pattern matched against the event's match value (the tool
   *  name for Pre/PostToolUse). Omit to match every invocation. Ignored
   *  on events without a match value (SessionStart/End, UserPromptSubmit,
   *  PreCompact, Stop). */
  matcher?: string;
  /** Shell command line. Runs via `sh -c "$command"` with the project's
   *  cwd. Receives `{event, payload}` JSON on stdin. */
  command: string;
  /** Per-hook timeout in ms. Defaults to 5000. */
  timeoutMs?: number;
}

export interface HooksConfig {
  SessionStart?: HookEntry[];
  UserPromptSubmit?: HookEntry[];
  PreToolUse?: HookEntry[];
  PostToolUse?: HookEntry[];
  PostToolUseFailure?: HookEntry[];
  PreCompact?: HookEntry[];
  SessionEnd?: HookEntry[];
  Stop?: HookEntry[];
  StopFailure?: HookEntry[];
}

interface WebConfig {
  /** Hostnames pre-seeded into the WebFetch allowlist at session start.
   *  Compared case-insensitively. Subdomain matching is exact (no wildcards
   *  yet); list each subdomain you want to allow explicitly. */
  allowlist?: string[];
}

/** One step in a rotation chain — provider + model. */
export interface RotationEntry {
  provider: string;
  model: string;
}

interface RotationConfig {
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
  /** Enable the Delegate tool for spawning a read-only research subagent. */
  subagents?: boolean;
  /** Load skills from .factory/skills/*.md and inject them based on triggers. */
  skills?: boolean;
  /** Run user-supplied shell commands at lifecycle events. Hook commands
   *  are configured under `agent.hooks.<EventName>` as `{matcher?,
   *  command, timeoutMs?}` entries. See README "Hooks" for the protocol. */
  hooks?: boolean;
  /** Show tool result output preview in the UI after each tool call.
   *  Defaults to false (hidden). Toggle with `/exp toolPreview on|off`. */
  toolPreview?: boolean;
}

export const EXPERIMENTAL_FLAG_KEYS = ['bashDedup', 'readCache', 'lineCountHint', 'subagents', 'skills', 'hooks', 'toolPreview'] as const;
export type ExperimentalFlagKey = typeof EXPERIMENTAL_FLAG_KEYS[number];

interface PermissionConfig {
  allowAll?: string[];
  /** Ordered list of Bash command patterns. First match wins. Patterns
   * are simple shell-style globs (`*`, `?`) matched against the raw
   * command string. Cannot override built-in forbidden patterns. */
  bashRules?: BashRuleConfig[];
}

export interface BashRuleConfig {
  pattern: string;
  decision: 'allow' | 'deny' | 'prompt';
  note?: string;
}

interface SecurityConfig {
  /** Env-var policy for the Bash subprocess. Deny-by-default; these
   * extend the small built-in allowlist. */
  bashEnv?: {
    allow?: string[];
    allowPrefixes?: string[];
    deny?: string[];
    denyPrefixes?: string[];
  };
  /** Path policy for Read/Write/Edit. User entries extend the built-in
   * deny list of secret paths but cannot remove from it. */
  paths?: {
    deny?: string[];
  };
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
interface ConfigKeys {
  [providerName: string]: ProviderKey[];
}

interface McpConfig {
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
  security?: SecurityConfig;
  mcp?: McpConfig;
}
