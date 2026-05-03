import type { Provider } from '../../providers/types.js';
import type { AgentEvent } from '../agent-types.js';
import type { ContextManager } from '../context-manager.js';
import type { FileCache } from './file-cache.js';

export interface CompactionDecision {
  /** True when usage stays above the hard ceiling and the agent should halt. */
  halt: boolean;
}

const HARD_CEILING = 0.9;

/**
 * Re-estimate usage from the current conversation, compact if past the soft
 * threshold, then escalate to an aggressive (mechanical, recencyWindow=0) pass
 * if the context is still over the hard ceiling. Halt only if both passes
 * couldn't free enough room.
 *
 * Yields one cumulative `compaction` event when anything was actually pruned.
 */
export async function* maybeCompact(
  contextManager: ContextManager | undefined,
  provider: Provider,
  model: string,
  signal: AbortSignal | undefined,
  fileCache?: FileCache,
): AsyncGenerator<AgentEvent, CompactionDecision> {
  if (!contextManager) return { halt: false };

  // Re-estimate from current messages — usage from a prior turn doesn't reflect
  // tool results added since.
  contextManager.updateUsage(undefined);

  let cumulativeOld: number | null = null;
  let cumulativeNew: number | null = null;
  let lastAggressive = false;

  if (contextManager.shouldCompact()) {
    yield { type: 'compaction-start', aggressive: false };
    const fingerprints = fileCache?.fingerprints();
    const result = await contextManager.compact(provider, model, signal, { fingerprints });
    if (result) {
      cumulativeOld = result.oldCount;
      cumulativeNew = result.newCount;
    }
  }

  if (contextManager.getUsagePercent() > HARD_CEILING) {
    yield { type: 'compaction-start', aggressive: true };
    const fingerprints = fileCache?.fingerprints();
    const result = await contextManager.compact(provider, model, signal, { aggressive: true, fingerprints });
    if (result) {
      if (cumulativeOld === null) cumulativeOld = result.oldCount;
      cumulativeNew = result.newCount;
      lastAggressive = true;
    }
  }

  if (cumulativeOld !== null && cumulativeNew !== null) {
    fileCache?.noteCompaction();
    yield {
      type: 'compaction',
      oldMessages: cumulativeOld,
      newMessages: cumulativeNew,
      aggressive: lastAggressive,
    };
  }

  return { halt: contextManager.getUsagePercent() > HARD_CEILING };
}
