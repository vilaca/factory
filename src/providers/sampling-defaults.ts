import { appendProviderLog } from '../utils/provider-log.js';

/**
 * Per-model sampling defaults map (next-steps.md §17).
 *
 * Each model family that the reliability spec verified gets its
 * recommended sampling parameters here, sourced from the HF model
 * card. Inline URL comments point at the card used so the values
 * stay auditable.
 *
 * The reliability spec measured a real ~3–8 point lift on most
 * 8B-class models in eval just from using the HF-card sampling defaults
 * instead of a hardcoded `T=0.7`. The point of this table is to make
 * those gains *opt-in by default* for callers who flag
 * `recommendedSampling: true`, and to log INFO when defaults exist for
 * a model but the caller forgot to opt in.
 *
 * Values are deliberately not invented. If a model card doesn't list a
 * setting, this map leaves it off — callers fall through to the
 * backend's own default rather than picking something that looks
 * plausible.
 */
export interface SamplingDefaults {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  presencePenalty?: number;
}

/**
 * Substring-keyed table. Lookup is case-insensitive — if the model
 * string contains the key (e.g. `'ministral-3:8b-reasoning-Q4_K_M'`
 * matches `'ministral'`-prefixed entries), the value applies.
 *
 * Longer / more specific keys win over shorter ones (we sort by key
 * length descending at lookup time) so a `ministral-3-reasoning` entry
 * is preferred over a bare `ministral-3`.
 */
const TABLE: Record<string, SamplingDefaults> = {
  // Ministral 3 8B Reasoning — https://huggingface.co/mistralai/Ministral-3-8B-Reasoning
  'ministral-3-reasoning': { temperature: 0.6, topP: 0.95 },
  // Ministral 3 8B Instruct — https://huggingface.co/mistralai/Ministral-3-8B-Instruct
  'ministral-3-instruct': { temperature: 0.05, topP: 1.0 },
  // Ministral 3 (family fallback when the variant suffix isn't in the name)
  'ministral-3': { temperature: 0.05 },

  // Qwen3 (thinking-mode default) — https://huggingface.co/Qwen/Qwen3-8B
  'qwen3-thinking': { temperature: 0.6, topP: 0.95, topK: 20, minP: 0 },
  // Qwen3 non-thinking — https://huggingface.co/Qwen/Qwen3-8B (Inference Parameters)
  'qwen3': { temperature: 0.7, topP: 0.8, topK: 20, minP: 0 },

  // IBM Granite 4.0 — https://huggingface.co/ibm-granite/granite-4.0-8b-instruct
  'granite-4.0': { temperature: 0.0 },
  'granite-4': { temperature: 0.0 },

  // Gemma 4 — https://huggingface.co/google/gemma-4-9b-it (rec. T=1.0)
  'gemma-4': { temperature: 1.0 },
};

/** Pure lookup. Each key is split on `-` into tokens; a model name
 *  matches if every token appears (anywhere) in the lowercased model
 *  string. This handles the in-the-wild naming variation:
 *    `Ministral-3-8B-Reasoning-Q4_K_M`
 *    `mistralai/Ministral-3-8B-Reasoning`
 *    `ministral-3:8b-reasoning-q4_k_m`
 *  all match the `ministral-3-reasoning` key.
 *
 *  Longest-token-set wins so a more specific key (Reasoning vs
 *  generic Ministral) is preferred. Returns `{}` for unknown models. */
export function getSamplingDefaults(model: string): SamplingDefaults {
  if (!model) return {};
  const m = model.toLowerCase();
  const keys = Object.keys(TABLE).sort((a, b) => {
    const al = a.split('-').length;
    const bl = b.split('-').length;
    if (al !== bl) return bl - al; // more tokens first
    return b.length - a.length;
  });
  for (const k of keys) {
    const tokens = k.toLowerCase().split('-').filter(t => t.length > 0);
    if (tokens.every(t => m.includes(t))) {
      return { ...TABLE[k] };
    }
  }
  return {};
}

const loggedInfoOnce = new Set<string>();

export class UnsupportedModelError extends Error {
  constructor(model: string) {
    super(
      `No sampling defaults recorded for model '${model}'. Add an entry to sampling-defaults.ts or call with strict: false.`,
    );
    this.name = 'UnsupportedModelError';
  }
}

/**
 * Policy layer over `getSamplingDefaults`. Used by provider clients
 * when the caller sets `recommendedSampling: true`.
 *
 *   strict=true, hit  → return defaults (caller knows what they're doing)
 *   strict=true, miss → throw UnsupportedModelError (caller asked for a
 *                       value-add we can't provide; better to fail
 *                       loudly than silently fall back)
 *   strict=false, hit → return defaults; INFO-log once per
 *                       (provider, model) so an operator looking at the
 *                       provider-events log sees what changed
 *   strict=false, miss → silent `{}` (default behavior — fall through
 *                        to backend defaults)
 */
export function applySamplingDefaults(
  model: string,
  opts: { strict: boolean; providerName?: string } = { strict: false },
): SamplingDefaults {
  const found = getSamplingDefaults(model);
  const hit = Object.keys(found).length > 0;
  if (opts.strict && !hit) {
    throw new UnsupportedModelError(model);
  }
  if (!opts.strict && hit) {
    const logKey = `${opts.providerName ?? '?'}::${model}`;
    if (!loggedInfoOnce.has(logKey)) {
      loggedInfoOnce.add(logKey);
      appendProviderLog({
        provider: opts.providerName ?? 'unknown',
        category: 'diagnostic',
        action: 'sampling-defaults-applied',
        outcome: 'started',
        detail: `model=${model} params=${JSON.stringify(found)}`,
      });
    }
  }
  return found;
}

/** Test-only — clear the one-shot logging memo so tests can assert on
 *  log activations in isolation. */
export function _resetSamplingLogForTests(): void {
  loggedInfoOnce.clear();
}
