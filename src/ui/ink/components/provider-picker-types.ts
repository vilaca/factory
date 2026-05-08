// Shared types for the provider-picker subviews. Pulled out of the main
// component file so the per-stage render helpers can be extracted without
// importing the orchestrator (which would create a cycle).

import type { SessionErrorStatus } from '../../../core/session-log.js';

export interface RecentPair {
  provider: string;
  model: string;
  /** Optional badge (throttled/quota/permission/error). */
  status?: SessionErrorStatus;
  /** Set when this recent pair was tied to a specific saved key. */
  keyId?: string;
}

export interface ProviderEntry {
  /** Canonical provider name (the key in PROVIDER_ALIASES values). */
  name: string;
  /** Display label, falls back to `name`. */
  label?: string;
  /** Dimmed + selection-blocked when true. */
  offline?: boolean;
}

/**
 * Optional per-model display info, used by both the startup picker (which
 * has access to the live Provider) and the mid-session picker (which only
 * knows model ids). When omitted, the picker just renders the model id.
 */
export interface ModelDisplayInfo {
  label?: string;
  warning?: string;
}

/** Subset of ProviderKey shown to the picker — token never crosses this surface. */
export interface KeySummary {
  id: string;
  label?: string;
  /** Last-4 fingerprint of the saved token. */
  fingerprint: string;
  /** Optional usage counters for the picker's compact stat column. */
  stats?: { ok: number; warn: number };
}

export interface ValidateResult {
  ok: boolean;
  /** Model ids returned by listModels, on success. */
  models?: string[];
  /** Error message, on failure. */
  error?: string;
}

export type Stage =
  | { kind: 'recent' }
  | { kind: 'provider' }
  | { kind: 'key'; provider: string; keys: KeySummary[]; selectedIdx: number }
  | { kind: 'key-delete'; provider: string; keys: KeySummary[]; selectedIdx: number }
  | { kind: 'key-confirm-delete'; provider: string; keys: KeySummary[]; selectedIdx: number }
  | { kind: 'key-add'; provider: string; tokenDraft: string }
  | { kind: 'key-validating'; provider: string; token: string }
  | { kind: 'key-validate-failed'; provider: string; token: string; error: string; choice: 0 | 1 }
  | { kind: 'loading'; provider: string; keyId?: string }
  | { kind: 'model'; provider: string; models: string[]; keyId?: string }
  | { kind: 'error'; provider: string; message: string };

/** How many rows the provider/model windowed list shows at once. */
export const VISIBLE_ROWS = 8;
