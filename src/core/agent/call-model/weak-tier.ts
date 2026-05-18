import type { Provider } from '../../../providers/types.js';

/**
 * Resolve a weak-tier model on the same provider as `currentModel`. Used
 * only for internal sub-calls — corrector retries (Phase 6) and compaction
 * summary (Phase 5). The user's primary turn is never routed through this.
 *
 * Returns null when the current model is not strong-tier or no weak-tier
 * mapping exists for this provider; callers fall back to the primary model.
 */
export function selectWeakTier(provider: Provider, currentModel: string): string | null {
  let caps;
  try {
    caps = provider.getCapabilities(currentModel);
  } catch {
    return null;
  }
  if (caps.modelTier !== 'strong') return null;
  const map = WEAK_TIER_MAP[provider.name];
  if (!map) return null;
  // Don't route to the same model.
  if (map === currentModel) return null;
  return map;
}

/** Static map of provider → weak-tier model. Curated, not auto-discovered;
 *  if a provider's weak-tier model name shifts, update here. */
const WEAK_TIER_MAP: Record<string, string> = {
  // TODO: dated snapshot id — silently 404s at first compaction / delegate
  // call if Anthropic retires it. The pre-live-listing AnthropicProvider
  // used to hardcode the same id in its allowlist, which kept the two in
  // sync by force; now that listModels() is live, this id can drift out
  // from under us. Options: switch to the undated alias 'claude-haiku-4-5',
  // or validate against listModels() output at startup and null out the
  // mapping with a warning if absent.
  anthropic: 'claude-haiku-4-5-20251001',
  openrouter: 'anthropic/claude-haiku-4-5',
  cerebras: 'llama3.1-8b',
  groq: 'llama-3.1-8b-instant',
  googleaistudio: 'gemini-2.5-flash',
  mistral: 'ministral-3b-latest',
};
