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
  // `seed` is per-call only by design (docs/reliability/next-steps.md §17):
  // a sticky instance-level seed would silently make every request
  // deterministic-on-the-same-prompt, which is almost never what the
  // caller intends. Reject loudly so the footgun shows up at startup
  // instead of as a mysterious lack of variation in production.
  if (ctx.instanceDefaults && 'seed' in ctx.instanceDefaults) {
    throw new TypeError(
      'resolveSampling: instanceDefaults.seed is not allowed — seed is per-call only. ' +
        'Pass `seed` on the per-call ChatOptions instead.',
    );
  }
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

/** Raised when a caller passes `thinking: true` to a model whose backend
 *  rejects the flag. Providers should set the `model` field so the agent
 *  layer can surface an actionable message. */
export class ThinkingNotSupportedError extends Error {
  constructor(public readonly model: string, cause?: string) {
    super(
      `Model '${model}' does not support inline thinking, but the caller passed thinking: true. ` +
        (cause ? `Backend reported: ${cause}` : 'Set thinking to false or "auto" to continue.'),
    );
    this.name = 'ThinkingNotSupportedError';
  }
}

/** Heuristic for the `'auto'` branch of ChatOptions.thinking. Returns
 *  true for models whose name advertises a reasoning / thinking fine-tune
 *  (Ministral Reasoning, Qwen3-thinking, DeepSeek-R, etc.). Cheap
 *  case-insensitive substring match — same shape the sampling-defaults
 *  table uses for `reason|think` keys. */
export function autoDetectThinking(model: string): boolean {
  return /reason|think/i.test(model);
}

/** Resolve the tri-state `thinking` per-call option (docs/reliability/next-steps.md §15)
 *  into a concrete boolean for the wire request. Pure — providers wrap
 *  this with their own resolved-mode cache so a backend that rejected
 *  the `true` request once gets downgraded to false for subsequent
 *  calls without re-asking the heuristic.
 *
 *  Returns:
 *    - the caller's explicit `true`/`false` verbatim
 *    - `autoDetectThinking(model)` for `'auto'` and `undefined`
 */
export function resolveThinking(
  model: string,
  thinking: boolean | 'auto' | undefined,
): boolean {
  if (thinking === true || thinking === false) return thinking;
  return autoDetectThinking(model);
}
