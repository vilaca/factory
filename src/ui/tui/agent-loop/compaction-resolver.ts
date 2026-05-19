// Resolver that ContextManager.compact() calls to obtain the
// (provider, model) used for the summarization model call.
//
// Behavior:
//   1. If `refs.compactionTarget` is already set (user picked earlier
//      this session, or headless pre-seeded it), use that.
//   2. Otherwise, if `refs.requestCompactionModel` is wired (TUI), call
//      it to prompt the user. On cancel → null bubbles up and compact()
//      aborts this turn; on commit → cache on refs.compactionTarget and
//      use it.
//   3. If neither is available (headless without --compaction-model and
//      no pre-seed), fall back to the primary (refs.provider,
//      refs.model). This preserves the no-fallback rule for TUI (where
//      the prompt path exists) while keeping headless functional.
//
// Provider instantiation: when the chosen tuple's provider matches the
// active session provider, reuse that instance — no auth re-resolution.
// Cross-provider picks (allowed by design) instantiate fresh via
// createProvider(). This call hits credential storage and lists no
// models — providers cache lazily. Compaction is infrequent enough that
// the per-call cost is acceptable; if profiling later shows otherwise,
// add a per-refs Map<providerName, Provider> cache.

import { createProvider, descriptorByAlias } from '../../../providers/registry.js';
import { getKey } from '../../../core/auth/credentials.js';
import { loadGlobalConfig } from '../../../core/config/index.js';
import type { Provider } from '../../../providers/types.js';
import type { CompactionTargetResolver } from '../../../core/context/context-manager.js';
import type { RunRefs } from './agent-loop-types.js';

export function makeCompactionResolver(refs: {
  current: RunRefs | null;
}): CompactionTargetResolver {
  return async () => {
    const r = refs.current;
    if (!r) return null;

    // 1. Already chosen this session?
    let target = r.compactionTarget;

    // 2. Prompt the user (TUI path).
    if (!target && r.requestCompactionModel) {
      const picked = await r.requestCompactionModel();
      if (picked === null) return null;
      target = picked;
      r.compactionTarget = picked;
    }

    // 3. Fallback for headless (no flag, no prompt wired): use primary.
    target ??= { providerName: r.provider.name, model: r.model };

    // Reuse the active provider when the names match — avoids a fresh
    // createProvider() + credential read on every compaction.
    if (target.providerName === r.provider.name) {
      return { provider: r.provider, model: target.model };
    }

    // Cross-provider: instantiate. Mirrors swap.ts:resolveProviderKey
    // minus the keyId steering — the picker doesn't carry a keyId hint
    // for the compaction target (the user picked from /pick-style UI
    // which doesn't currently surface alternate keys for the *non-
    // active* provider). First saved key wins, same as the historical
    // default.
    let provider: Provider;
    try {
      const descriptor = descriptorByAlias(target.providerName);
      const createOpts: Parameters<typeof createProvider>[1] = {};
      if (descriptor) {
        const cfg = await loadGlobalConfig();
        const key = getKey(cfg, descriptor.name);
        if (key) {
          createOpts.token = key.token;
          if (descriptor.needsAccountId && key.extras?.accountId) {
            createOpts.accountId = key.extras.accountId;
          }
        }
      }
      provider = createProvider(target.providerName, createOpts);
    } catch {
      // No auth / unknown provider — fall back to the primary instance.
      // The compaction call may still fail and trip the mechanical
      // summary path; that's a strictly better outcome than throwing
      // out of compact().
      return { provider: r.provider, model: r.model };
    }
    return { provider, model: target.model };
  };
}
