// Provider priming — the single bridge from `UnprimedProvider`
// (returned by `createProvider`) to the full `Provider` surface.
//
// Background: every provider class implements both `UnprimedProvider`
// and `Provider` (they are the same instance — the split is a type-
// level discipline, not a runtime distinction). `createProvider` is
// typed to return the narrow `UnprimedProvider` so that callers cannot
// use methods like `getCapabilities` / `chat` until they have routed
// the instance through `prime()`. This catches the cf880ed bug class
// (mint provider → call getCapabilities → unhandled cache miss in
// Anthropic) at compile time.
//
// Why one function instead of inlined `await p.listModels()`: the
// listModels-priming step grew an additional contract over time
// (Ollama's primeModelCache for context_length). Centralising means
// every call site automatically gets the right priming for its
// target provider, including future additions.

import type { Provider, UnprimedProvider } from './types.js';

export interface PrimedResult {
  provider: Provider;
  /** Model list returned by the priming `listModels()` call. Returned
   *  alongside the primed provider so the common "prime, then pick a
   *  model from the list" pattern doesn't issue a second network call. */
  models: string[];
}

/** Prime a freshly-minted provider so its full surface is safe to use.
 *
 *  Steps:
 *    1. Always call `listModels()` — this populates the model-info cache
 *       that providers' synchronous `getCapabilities` reads from.
 *    2. If `targetModel` is supplied AND the provider implements
 *       `primeModelCache`, also call it. This covers per-model side
 *       data beyond the model list (Ollama's `/api/show` context window).
 *
 *  Errors from `listModels()` propagate — callers that catch them are
 *  responsible for deciding whether to fall back. Errors from
 *  `primeModelCache` are swallowed by the provider itself (it's a
 *  best-effort warm-up; see OllamaProvider.primeModelCache).
 *
 *  Returns the SAME instance, narrowed to `Provider`. The cast is safe
 *  because every concrete provider class implements both interfaces. */
export async function prime(
  p: UnprimedProvider,
  targetModel?: string,
): Promise<PrimedResult> {
  const models = await p.listModels();
  if (targetModel && p.primeModelCache) {
    await p.primeModelCache(targetModel);
  }
  return { provider: p as unknown as Provider, models };
}
