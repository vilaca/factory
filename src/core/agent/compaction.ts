import type { Provider } from '../../providers/types.js';
import type { AgentEvent } from '../agent-types.js';
import type { ContextManager } from '../context-manager.js';
import type { FileCache } from './file-cache.js';
import { runHook } from '../hooks/index.js';

export interface CompactionHookOptions {
  hooksEnabled?: boolean;
  /** Live cwd holder; we dereference at each hook fire so PreCompact picks
   *  up project-local hooks even after Bash `cd`'d mid-turn. */
  cwdRef?: { current: string };
  hooksConfig?: import('../config-types.js').HooksConfig;
  onHookStderr?: (command: string, chunk: string) => void;
  onHookError?: (event: string, error: string) => void;
}

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
  hookOpts?: CompactionHookOptions,
): AsyncGenerator<AgentEvent, CompactionDecision> {
  if (!contextManager) return { halt: false };

  // Re-estimate from current messages — usage from a prior turn doesn't reflect
  // tool results added since.
  contextManager.updateUsage(undefined);

  // Pre-flight: age old tool results in place. Cheaper than full
  // compaction and cache-friendly (only old messages change, so the
  // recent prefix stays warm). Re-estimates internally; if this pulls us
  // back under the soft threshold the rest of this function no-ops.
  contextManager.ageOldToolResults();

  let cumulativeOld: number | null = null;
  let cumulativeNew: number | null = null;
  let lastAggressive = false;

  if (contextManager.shouldCompact()) {
    yield { type: 'compaction-start', aggressive: false };
    const fingerprints = fileCache?.fingerprints();
    const precomputedSummary = yield* runPreCompactHook(false, hookOpts);
    const result = await contextManager.compact(provider, model, signal, {
      fingerprints,
      ...(precomputedSummary !== undefined ? { precomputedSummary } : {}),
    });
    if (result) {
      cumulativeOld = result.oldCount;
      cumulativeNew = result.newCount;
    }
  }

  if (contextManager.getUsagePercent() > HARD_CEILING) {
    yield { type: 'compaction-start', aggressive: true };
    const fingerprints = fileCache?.fingerprints();
    const precomputedSummary = yield* runPreCompactHook(true, hookOpts);
    const result = await contextManager.compact(provider, model, signal, {
      aggressive: true,
      fingerprints,
      ...(precomputedSummary !== undefined ? { precomputedSummary } : {}),
    });
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

/**
 * Run the PreCompact hook (if enabled). The hook receives `{ aggressive }`
 * on stdin and may return `{ additionalContext: "..." }` to override the
 * summary that compaction installs in place of the pruned messages. Errors
 * are surfaced as `hook-error` events but never block compaction.
 */
async function* runPreCompactHook(
  aggressive: boolean,
  hookOpts: CompactionHookOptions | undefined,
): AsyncGenerator<AgentEvent, string | undefined> {
  if (!hookOpts?.hooksEnabled || !hookOpts.cwdRef) return undefined;
  try {
    const result = await runHook(
      'PreCompact',
      { aggressive },
      {
        cwd: hookOpts.cwdRef.current,
        config: hookOpts.hooksConfig,
        onStderr: hookOpts.onHookStderr,
      },
    );
    for (const e of result.errors) {
      hookOpts.onHookError?.('PreCompact', e);
      yield { type: 'hook-error', event: 'PreCompact', error: e };
    }
    for (const hookPath of result.firedCommands) {
      yield {
        type: 'hook-fired',
        event: 'PreCompact',
        hookPath,
        ...(result.notice ? { notice: result.notice } : {}),
      };
    }
    return result.additionalContext;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    hookOpts.onHookError?.('PreCompact', msg);
    yield { type: 'hook-error', event: 'PreCompact', error: msg };
    return undefined;
  }
}
