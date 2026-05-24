import type { ModelTier, ReasoningEffort } from '../types.js';

/**
 * Single source of truth for OpenAI per-family capability metadata.
 *
 * `/v1/models` ships only `{id, created, object, owned_by}` — no context
 * size, max output, modality, reasoning flag, or deprecation status. Every
 * one of those has to be inferred from the model id, so we keep them all
 * in one table instead of scattering startsWith chains across six functions.
 *
 * Lookup uses longest-matching prefix (so `gpt-4o-mini` beats `gpt-4o`),
 * which makes array order irrelevant — keep the rows grouped by family for
 * readability. Add a row when a new family ships; tweak existing rows when
 * a family is retired (set `deprecated: true`) or extended.
 *
 * Defaults when no row matches: ctx 128k, maxOut 16k, no reasoning, no
 * vision, supportsTools true, tier from generic mini/nano heuristic. New
 * unknown ids therefore land in the middle of `strong` tier — visible but
 * not at the top — until someone adds a row.
 */
interface OpenAIFamily {
  prefix: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** Override for the generic tier heuristic. */
  tier?: ModelTier;
  reasoning?: boolean;
  vision?: boolean;
  /** Defaults to true. Set false for models that are tool-disabled. */
  supportsTools?: boolean;
  /** Drives both the picker 'deprecated' warning and tier='weak'. */
  deprecated?: boolean;
}

const OPENAI_FAMILIES: ReadonlyArray<OpenAIFamily> = [
  // Current flagships
  {
    prefix: 'gpt-5-codex',
    contextWindow: 1_047_576,
    maxOutputTokens: 128_000,
    tier: 'strong',
    reasoning: true,
    vision: true,
  },
  {
    prefix: 'gpt-5',
    contextWindow: 1_047_576,
    maxOutputTokens: 128_000,
    tier: 'strong',
    reasoning: true,
    vision: true,
  },
  {
    prefix: 'gpt-4.1',
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    tier: 'strong',
    vision: true,
  },

  // Reasoning series
  {
    prefix: 'o4-mini',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    tier: 'medium',
    reasoning: true,
    vision: true,
  },
  {
    prefix: 'o4',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    tier: 'strong',
    reasoning: true,
    vision: true,
  },
  {
    prefix: 'o3-mini',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    tier: 'medium',
    reasoning: true,
    vision: true,
  },
  {
    prefix: 'o3',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    tier: 'strong',
    reasoning: true,
    vision: true,
  },
  {
    prefix: 'o1-pro',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    tier: 'strong',
    reasoning: true,
    vision: true,
  },
  {
    prefix: 'o1-preview',
    contextWindow: 128_000,
    maxOutputTokens: 100_000,
    tier: 'strong',
    reasoning: true,
    vision: true,
    supportsTools: false,
  },
  {
    prefix: 'o1-mini',
    contextWindow: 128_000,
    maxOutputTokens: 100_000,
    tier: 'medium',
    reasoning: true,
    vision: true,
    supportsTools: false,
  },
  {
    prefix: 'o1',
    contextWindow: 128_000,
    maxOutputTokens: 100_000,
    tier: 'strong',
    reasoning: true,
    vision: true,
  },

  // Multimodal flagship line
  {
    prefix: 'gpt-4o-mini',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    tier: 'medium',
    vision: true,
  },
  {
    prefix: 'gpt-4o',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    tier: 'strong',
    vision: true,
  },

  // Deprecated families — surface a warning and pin to weak tier
  { prefix: 'gpt-4-turbo', contextWindow: 128_000, maxOutputTokens: 4_096, deprecated: true },
  { prefix: 'gpt-4-1106', contextWindow: 128_000, maxOutputTokens: 4_096, deprecated: true },
  { prefix: 'gpt-4-', contextWindow: 128_000, maxOutputTokens: 4_096, deprecated: true },
  {
    prefix: 'gpt-3.5-turbo-instruct',
    contextWindow: 16_385,
    maxOutputTokens: 4_096,
    deprecated: true,
    supportsTools: false,
  },
  { prefix: 'gpt-3.5-turbo', contextWindow: 16_385, maxOutputTokens: 4_096, deprecated: true },
];

function canonicalizeModelForFamilyLookup(model: string): string {
  const lower = model.toLowerCase();
  // Normalize dotted codex minors so capability lookup hits the codex family
  // row (`gpt-5.3-codex` -> `gpt-5-codex`, `gpt-5.1-codex-mini` ->
  // `gpt-5-codex-mini`) while routing still keys off `/codex/i` separately.
  return lower.replace(/^gpt-5\.\d+-codex/, 'gpt-5-codex');
}

export function lookupFamily(model: string): OpenAIFamily | undefined {
  const normalized = canonicalizeModelForFamilyLookup(model);
  let best: OpenAIFamily | undefined;
  for (const family of OPENAI_FAMILIES) {
    if (
      normalized.startsWith(family.prefix) &&
      (!best || family.prefix.length > best.prefix.length)
    ) {
      best = family;
    }
  }
  return best;
}

export function estimateModelTier(model: string): ModelTier {
  const family = lookupFamily(model);
  if (family?.deprecated) return 'weak';
  const baseTier: ModelTier = family?.tier ?? 'strong';
  // A family row encodes the *default* tier for that family; mini/nano
  // variants of a strong family are still smaller models. Apply the
  // generic demotion on top of `strong` rows so e.g. `gpt-5.1-codex-mini`
  // (which matches the `gpt-5` row) lands in `medium`. Explicit `medium`
  // or `weak` rows already account for being a mini and aren't demoted
  // again.
  if (baseTier === 'strong' && /(?:^|[-/])(?:mini|nano)\b/.test(model)) return 'medium';
  return baseTier;
}

export function estimateContextWindow(model: string): number {
  return lookupFamily(model)?.contextWindow ?? 128_000;
}

export function estimateMaxOutput(model: string): number {
  return lookupFamily(model)?.maxOutputTokens ?? 16_384;
}

export function isReasoningModel(model: string): boolean {
  return lookupFamily(model)?.reasoning ?? false;
}

export function defaultReasoningEffort(model: string): ReasoningEffort | undefined {
  // Codex with no reasoning runs like a chat-tuned model and narrates instead
  // of acting. `medium` gives action bias without the latency tax of `high`.
  // Non-codex reasoning models (gpt-5, o-series) can run lower since they're
  // less prone to the same failure mode.
  // Refs:
  //   https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_troubleshooting_guide
  //   https://platform.openai.com/docs/guides/reasoning
  if (!isReasoningModel(model)) return undefined;
  if (/codex/i.test(model)) return 'medium';
  return 'low';
}

export function isResponsesApiOnly(model: string): boolean {
  // Substring rather than the family table so dotted minor versions —
  // gpt-5.1-codex, gpt-5.3-codex, gpt-5.1-codex-mini — all route to
  // /v1/responses without one row per variant. Family-prefix matching
  // is hyphen-anchored ('gpt-5-codex' doesn't startsWith 'gpt-5.3-codex').
  // 'codex' is OpenAI-specific terminology; safe to match generically inside
  // the OpenAI provider.
  return /codex/i.test(model);
}

export function supportsToolsByName(model: string): boolean {
  return lookupFamily(model)?.supportsTools ?? true;
}

export function supportsParallelToolCalls(model: string): boolean {
  if (!supportsToolsByName(model)) return false;
  // Narrowed to o-series specifically. gpt-5 and codex are reasoning models
  // too but they support parallel tool calls and the GPT-5 cookbook
  // explicitly recommends parallelization for read-only tool batches —
  // gating on the broader `isReasoningModel` predicate would needlessly
  // serialize them.
  if (/^o\d/i.test(model)) return false;
  return true;
}

export function supportsVisionByName(model: string): boolean {
  return lookupFamily(model)?.vision ?? false;
}
