// Shared "cross-provider compaction target" resolver. Both the TUI agent
// loop and the headless runner used to inline the same descriptor →
// auth → createProvider → prime → instrument sequence; this is the
// single source of truth.
//
// Lives under src/ui/agent-events/ rather than src/ui/tui/ so the
// headless runner can import without violating the
// "headless must not depend on tui" arch rule.

import { createProvider, descriptorByAlias } from '../../providers/registry.js';
import { prime } from '../../providers/prime.js';
import { getKey } from '../../core/auth/credentials.js';
import { loadGlobalConfig } from '../../core/config/index.js';
import { instrumentProviderRequests } from '../../providers/instrument.js';
import { logModelRequestTo } from '../session-bridge.js';
import type { Provider } from '../../providers/types.js';
import type { SessionLogger } from '../../core/session/session-log.js';

export interface CompactionResolverInputs {
  /** Active session state. The resolver falls back to this when no
   *  override is supplied, when the override's provider matches the
   *  active provider name, or when the cross-provider build fails. */
  active: {
    provider: Provider;
    model: string;
    sessionLogger?: SessionLogger | undefined;
  };
  /** Optional override (e.g. user picked via `/compaction-model`, or
   *  headless got `--compaction-model`). When absent, resolves to the
   *  active tuple. */
  target?: { providerName: string; model: string };
}

/** Resolve which (provider, model) the next compaction summary call
 *  should run on. Behaviour:
 *
 *    - No override or same-provider override → reuse the active provider
 *      instance (no auth re-resolution, no fresh createProvider).
 *    - Cross-provider override → instantiate the target provider, prime
 *      it for the same cf880ed contract that swap.ts honors, and wrap
 *      it in `instrumentProviderRequests` tagged 'compaction' so the
 *      session log buckets summary traffic separately from main turns.
 *    - On failure (no auth, unknown provider, prime threw) → log a
 *      warning on the session logger if present and fall back to the
 *      active tuple. The compaction call may still fail and trip the
 *      mechanical-summary path; that's strictly better than throwing
 *      out of compact(). */
export async function resolveCompactionTarget(
  inputs: CompactionResolverInputs,
): Promise<{ provider: Provider; model: string }> {
  const { active, target } = inputs;

  if (!target || target.providerName === active.provider.name) {
    return { provider: active.provider, model: target?.model ?? active.model };
  }

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
    const { provider: fresh } = await prime(unprimed, target.model);
    const logger = active.sessionLogger;
    const wrapped = logger
      ? instrumentProviderRequests(fresh, info => logModelRequestTo(logger, info), 'compaction')
      : fresh;
    return { provider: wrapped, model: target.model };
  } catch (err) {
    active.sessionLogger?.logWarning(
      'compaction-resolver',
      `${target.providerName}:${target.model} — ${err instanceof Error ? err.message : String(err)}`,
    );
    return { provider: active.provider, model: active.model };
  }
}
