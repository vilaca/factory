// Thin TUI wrapper around the shared compaction-target resolver in
// src/ui/agent-events/compaction-resolver.ts. The shared module owns the
// cross-provider build (descriptor → auth → createProvider → prime →
// instrument) and the same-provider / fallback branches; this wrapper
// adapts it to the TUI's RunRefs-keyed lifecycle so the resolver runs
// against fresh state each time ContextManager.compact() asks.
//
// Behavior: if `refs.compactionTarget` is set (user picked via
// `/compaction-model`, or headless pre-seeded it via `--compaction-model`),
// use that tuple. Otherwise fall back to the primary (refs.provider,
// refs.model).

import { resolveCompactionTarget } from '../../agent-events/compaction-resolver.js';
import type { CompactionTargetResolver } from '../../../core/context/context-manager.js';
import type { RunRefs } from './agent-loop-types.js';

export function makeCompactionResolver(refs: {
  current: RunRefs | null;
}): CompactionTargetResolver {
  return async () => {
    const r = refs.current;
    if (!r) return null;
    return resolveCompactionTarget({
      active: { provider: r.provider, model: r.model, sessionLogger: r.sessionLogger },
      target: r.compactionTarget,
    });
  };
}
