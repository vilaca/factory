import type { ChatOptions } from './types.js';
import { applySamplingDefaults, getSamplingDefaults } from './sampling-defaults.js';

/** Strip trailing slashes from a base URL so callers can append paths
 * without worrying about double slashes. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Standard `Authorization: Bearer <token>` header object. */
export function bearerAuth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** Parse a tool-call `arguments` string from a provider's wire format.
 * Most providers send JSON, but a malformed payload should not crash the
 * stream — fall back to a `{ _raw: <string> }` envelope so the agent layer
 * can surface the original text to the corrector. */
export function parseToolArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

export { formatTokenCount } from '../utils/format-tokens.js';

/**
 * Reliability stack (Phase 10): resolve final sampling values for one
 * request. Blends three sources with priority (later overrides earlier):
 *   1. Per-model defaults table (docs/reliability/next-steps.md §17). Applied when
 *      `opts.recommendedSampling` is true OR an entry exists for the
 *      model (auto-enable for known small-model deployments).
 *   2. Provider-instance defaults (passed in via `instanceDefaults`).
 *   3. Per-call overrides on `opts` (`temperature`, `topP`, etc.).
 *
 * Returns an object using OpenAI snake_case keys, since most providers
 * speak some OpenAI dialect. Anthropic and Ollama-native callers
 * remap as needed.
 */
export interface ResolvedSampling {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  repeat_penalty?: number;
  presence_penalty?: number;
  seed?: number;
}

/** Camel-cased ChatOptions key → snake_case wire key. Single source of
 *  truth so resolveSampling stays a thin merge over a data table
 *  instead of a long ladder of conditional assigns. */
const SAMPLING_FIELD_MAP: ReadonlyArray<[keyof ChatOptions, keyof ResolvedSampling]> = [
  ['temperature', 'temperature'],
  ['topP', 'top_p'],
  ['topK', 'top_k'],
  ['minP', 'min_p'],
  ['repeatPenalty', 'repeat_penalty'],
  ['presencePenalty', 'presence_penalty'],
  ['seed', 'seed'],
];

function mergeDefaults(out: ResolvedSampling, defaults: ReturnType<typeof getSamplingDefaults>): void {
  if (defaults.temperature !== undefined) out.temperature = defaults.temperature;
  if (defaults.topP !== undefined) out.top_p = defaults.topP;
  if (defaults.topK !== undefined) out.top_k = defaults.topK;
  if (defaults.minP !== undefined) out.min_p = defaults.minP;
  if (defaults.repeatPenalty !== undefined) out.repeat_penalty = defaults.repeatPenalty;
  if (defaults.presencePenalty !== undefined) out.presence_penalty = defaults.presencePenalty;
}

function mergeOverrides(out: ResolvedSampling, opts: ChatOptions): void {
  for (const [src, dst] of SAMPLING_FIELD_MAP) {
    const v = opts[src];
    if (typeof v === 'number') (out as Record<string, number>)[dst] = v;
  }
}

export function resolveSampling(
  opts: ChatOptions | undefined,
  ctx: { model: string; providerName?: string; instanceDefaults?: ResolvedSampling } = {
    model: '',
  },
): ResolvedSampling {
  const out: ResolvedSampling = { ...(ctx.instanceDefaults ?? {}) };
  const hasEntry = Object.keys(getSamplingDefaults(ctx.model)).length > 0;
  if (opts?.recommendedSampling || hasEntry) {
    mergeDefaults(
      out,
      applySamplingDefaults(ctx.model, {
        strict: false,
        ...(ctx.providerName ? { providerName: ctx.providerName } : {}),
      }),
    );
  }
  if (opts) mergeOverrides(out, opts);
  return out;
}

/**
 * Merge resolved sampling fields into an OpenAI-style request body.
 * In-place mutation, returns the same body for chaining. Drops
 * undefined keys so the body stays minimal.
 */
export function applySamplingToBody(
  body: Record<string, unknown>,
  sampling: ResolvedSampling,
): Record<string, unknown> {
  for (const [k, v] of Object.entries(sampling)) {
    if (v !== undefined) body[k] = v;
  }
  return body;
}
