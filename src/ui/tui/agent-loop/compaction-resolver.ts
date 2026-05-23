// Resolver that ContextManager.compact() calls to obtain the
// (provider, model) used for the summarization model call.
//
// Behavior: if `refs.compactionTarget` is set (user picked via
// `/compaction-model`, or headless pre-seeded it via `--compaction-model`),
// use that tuple. Otherwise fall back to the primary (refs.provider,
// refs.model). The TUI used to auto-prompt the user on the first
// compaction; that surprised users into a picker for an operation that
// does not in itself imply a model change. `/compaction-model` is now the
// only way to opt into a non-primary target.
//
// Provider instantiation: when the chosen tuple's provider matches the
// active session provider, reuse that instance — no auth re-resolution.
// Cross-provider picks (allowed by design) instantiate fresh via
// createProvider(). This call hits credential storage and lists no
// models — providers cache lazily. Compaction is infrequent enough that
// the per-call cost is acceptable; if profiling later shows otherwise,
// add a per-refs Map<providerName, Provider> cache.

import { createProvider, descriptorByAlias } from '../../../providers/registry.js';
import { prime } from '../../../providers/prime.js';
import { getKey } from '../../../core/auth/credentials.js';
import { loadGlobalConfig } from '../../../core/config/index.js';
import { instrumentProviderRequests } from '../../../providers/instrument.js';
import { logModelRequestTo } from '../../session-bridge.js';
import type { Provider } from '../../../providers/types.js';
import type { CompactionTargetResolver } from '../../../core/context/context-manager.js';
import type { RunRefs } from './agent-loop-types.js';

export function makeCompactionResolver(refs: {
  current: RunRefs | null;
}): CompactionTargetResolver {
  return async () => {
    const r = refs.current;
    if (!r) return null;

    // No target set → use the active provider+model. This is the default
    // for every TUI session and for headless without `--compaction-model`.
    const target = r.compactionTarget ?? { providerName: r.provider.name, model: r.model };

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
      const unprimed = createProvider(target.providerName, createOpts);
      // Prime before use — the compaction call hits chat/chatNoStream
      // (and may consult getCapabilities), so the same cf880ed contract
      // applies as in swap.ts. Without this, an Anthropic compaction
      // target would throw on its first getCapabilities() lookup.
      const { provider: fresh } = await prime(unprimed, target.model);
      // Tag this call path as 'compaction' so the session log can bucket
      // mechanical-summary requests separately from main-turn traffic. The
      // primary-fallback branch already runs on the instrumented refs.provider
      // (which is tagged 'main') — that's fine: the source field is a hint,
      // not a contract.
      provider = r.sessionLogger
        ? instrumentProviderRequests(
            fresh,
            info => logModelRequestTo(r.sessionLogger, info),
            'compaction',
          )
        : fresh;
    } catch (err) {
      // No auth / unknown provider — fall back to the primary instance.
      // The compaction call may still fail and trip the mechanical
      // summary path; that's a strictly better outcome than throwing
      // out of compact().
      r.sessionLogger?.logWarning(
        'compaction-resolver',
        `${target.providerName}:${target.model} — ${err instanceof Error ? err.message : String(err)}`,
      );
      return { provider: r.provider, model: r.model };
    }
    return { provider, model: target.model };
  };
}
