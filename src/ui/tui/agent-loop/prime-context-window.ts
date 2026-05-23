// Shared helper for setup.ts (mount-time) and swap.ts (post-swap). Both
// sites need to ask the active provider for its real context window via
// the async `primeModelCache` hook (ollama's `/api/show` lookup), then
// settle the result back into ContextManager + React state. The
// provider/model identity check guards against a second mount or swap
// landing while this is in flight — we only update the manager if refs
// still point at the same tuple we primed for.

import type { MutableRefObject } from 'react';
import type { RunRefs } from './agent-loop-types.js';

/** Fire-and-forget prime. Pulls the current provider+model off `refs`,
 *  calls `primeModelCache` if the provider implements it, and on
 *  resolution refreshes ContextManager and React state with the value
 *  `getCapabilities` now returns. No-op when the provider has no
 *  prime hook. The primed value is the model's actual context — trust
 *  it whether it's larger or smaller than the estimate. */
export function primeContextWindowFromActiveProvider(
  refs: MutableRefObject<RunRefs | null>,
  setContextWindow: (n: number) => void,
): void {
  const current = refs.current;
  if (!current) return;
  const provider = current.provider;
  const activeModel = current.model;
  if (!provider.primeModelCache) return;
  void provider.primeModelCache(activeModel).then(() => {
    const after = refs.current;
    if (!after || after.provider !== provider || after.model !== activeModel) return;
    const updated = provider.getCapabilities(activeModel).contextWindow;
    after.contextManager.setContextWindow(updated);
    setContextWindow(updated);
  });
}
