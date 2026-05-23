// Shared types for the provider-picker subviews. Pulled out of the main
// component file so the per-stage render helpers can be extracted without
// importing the orchestrator (which would create a cycle).

import type { ModelTier } from '../../../../providers/types.js';
import type { ModelSelection } from '../../../../core/selection/types.js';

/** Picker-side alias of the canonical ModelSelection record. Kept as a
 *  named type for the existing call sites; new code can import
 *  `ModelSelection` directly. The 550f093 bug was specifically that
 *  hops between picker and agent loop re-declared this shape with
 *  fields stripped — alias rather than redeclare. */
export type RecentPair = ModelSelection;

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
  detail?: string;
  warning?: string;
  /** Coding-suitability tier — primary picker sort key. */
  tier?: ModelTier;
  /** Coding-specialist fine-tune (codex/coder). Floats above non-specialists
   *  within the same tier since this CLI is a coding agent. */
  codingSpecialist?: boolean;
  /** Context window size in tokens — sort key (descending). */
  contextWindow?: number;
  /** Max output tokens — sort key (descending). */
  maxOutputTokens?: number;
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
