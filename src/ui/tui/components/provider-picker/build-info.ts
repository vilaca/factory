import type { Provider } from '../../../../providers/types.js';
import type { ModelDisplayInfo } from './types.js';

/** Coding-specialist fine-tunes typically embed `codex` or `coder` in the
 *  model id (OpenAI's gpt-5-codex line, Qwen's qwen3-coder). Detected
 *  generically rather than per-provider so any future coding-specialist
 *  family is correctly boosted in the picker without code changes. */
function isCodingSpecialistName(model: string): boolean {
  return /(?:^|[-/])(?:codex|coder)\b/i.test(model);
}

/**
 * Builds the picker-side display info for a (provider, model) pair from
 * the live Provider's pure inspection methods. Both Session.tsx (mid-session
 * picker) and menu.tsx (startup picker) call this so the picker shows
 * consistent labels/tiers regardless of which entry point opened it.
 */
export function buildPickerInfo(source: Provider, model: string): ModelDisplayInfo | undefined {
  const info = source.getModelPickerInfo?.(model);
  const label = info?.label ?? source.getDisplayModelName?.(model);
  let tier;
  let contextWindow;
  let maxOutputTokens;
  let codingSpecialist;
  try {
    const caps = source.getCapabilities(model);
    tier = caps.modelTier;
    contextWindow = caps.contextWindow;
    maxOutputTokens = caps.maxOutputTokens;
    codingSpecialist = caps.codingSpecialist ?? isCodingSpecialistName(model);
  } catch {
    // Unknown model — capabilities estimator may throw; sort puts it last.
  }
  codingSpecialist ??= isCodingSpecialistName(model);
  if (!label && !info?.warning && !info?.detail && !tier && !contextWindow) {
    return undefined;
  }
  return {
    label,
    warning: info?.warning,
    detail: info?.detail,
    tier,
    contextWindow,
    maxOutputTokens,
    codingSpecialist,
  };
}
