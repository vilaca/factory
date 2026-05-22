import type { Provider, ToolDefinition } from '../../providers/types.js';
import type { AgentEvent } from './types.js';
import type { ContextManager } from '../context/context-manager.js';
import type { HooksConfig } from '../config/types.js';
import type { EnvPolicy } from '../../security/env.js';
import type { FileCache } from './cache/file-cache.js';
import { errorMessage } from '../../utils/errors.js';
import { runHook } from '../hooks/index.js';

interface CompactionOptions {
  hooksEnabled?: boolean;
  /** Live cwd holder; we dereference at each hook fire so PreCompact picks
   *  up project-local hooks even after Bash `cd`'d mid-turn. */
  cwdRef?: { current: string };
  hooksConfig?: HooksConfig;
  envPolicy?: EnvPolicy;
  onHookStderr?: (command: string, chunk: string) => void;
  onHookError?: (event: string, error: string) => void;
  /** Native tool definitions sent alongside the next model call. Threaded
   *  through to `ContextManager` so the pre-flight estimate accounts for
   *  the tool-schema overhead and to `compact()` so the post-summary
   *  refresh stays accurate. Must match what the agent loop will hand to
   *  `provider.chat`. */
  toolDefinitions?: ToolDefinition[];
}

interface CompactionDecision {
  /** True when usage stays above the hard ceiling and the agent should halt. */
  halt: boolean;
  /** True when this call actually rewrote conversation messages (soft or
   *  aggressive pass produced a result). Callers use this to invalidate
   *  cached pointers that reference message indices — e.g. the OpenAI
   *  Responses-API chain, whose `messageCount` slice would alias into
   *  rewritten history after compaction. */
  compacted: boolean;
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
  fileCache: FileCache | undefined,
  opts: CompactionOptions | undefined,
): AsyncGenerator<AgentEvent, CompactionDecision> {
  if (!contextManager) return { halt: false, compacted: false };
  // Reset the "user cancelled compaction this turn" latch — it's a
  // turn-scoped suppressor for the aggressive pass below, not a session
  // setting. Without this, a cancel in turn N would silently disable
  // compaction prompts in turn N+1.
  contextManager.clearCompactionCancelled();
  // Normalize once — `[]` matches "no tools sent" everywhere downstream
  // (`refreshEstimate`, `ageOldToolResults`, the post-compact refresh).
  const toolDefinitions = opts?.toolDefinitions ?? [];

  // Re-estimate from current messages + tool schema — usage from a prior turn
  // doesn't reflect tool results added since.
  contextManager.refreshEstimate(toolDefinitions);

  // Pre-flight: age old tool results in place. Cheaper than full
  // compaction and cache-friendly (only old messages change, so the
  // recent prefix stays warm). Re-estimates internally; if this pulls us
  // back under the soft threshold the rest of this function no-ops.
  contextManager.ageOldToolResults(toolDefinitions);

  let cumulativeOld: number | null = null;
  let cumulativeNew: number | null = null;
  let lastAggressive = false;
  let phaseReached: 0 | 1 | 2 | 3 | 4 = 0;

  // Tiered phases 1–3 are deterministic text manipulation, no LLM call,
  // sub-millisecond. They preserve reasoning traces (interpretive
  // context) while shedding nudges and raw tool data — the spec's
  // measured +18-point lift vs sliding-window at moderate pressure.
  if (contextManager.shouldCompact()) {
    const tiered = contextManager.tieredCompact(toolDefinitions);
    if (tiered.changed) {
      cumulativeOld = tiered.oldCount;
      cumulativeNew = tiered.newCount;
      phaseReached = tiered.phase;
      contextManager.setLastCompactionPhase(tiered.phase);
    }
  }

  // Phase 4 (emergency): the LLM-summary path. Only if the tiered cuts
  // didn't free enough — typically because the remaining tool_call
  // skeletons + recent boundaries still exceed the budget. The summary
  // call is the existing model-assisted compaction; the framework
  // calls this an anti-pattern (docs/reliability/next-steps.md §38) for normal use,
  // but as a last-resort it's better than the request 500ing.
  if (contextManager.shouldCompact()) {
    yield { type: 'compaction-start', aggressive: false };
    const fingerprints = fileCache?.fingerprints();
    const precomputedSummary = yield* runPreCompactHook(false, opts);
    const result = await contextManager.compact(provider, model, signal, {
      fingerprints,
      toolDefinitions,
      ...(precomputedSummary !== undefined ? { precomputedSummary } : {}),
    });
    if (result) {
      cumulativeOld ??= result.oldCount;
      cumulativeNew = result.newCount;
      phaseReached = 4;
      contextManager.setLastCompactionPhase(0); // tiered phase is per-pass; 0 = summary path took over
    }
  }

  if (contextManager.getUsagePercent() > HARD_CEILING) {
    yield { type: 'compaction-start', aggressive: true };
    const fingerprints = fileCache?.fingerprints();
    const precomputedSummary = yield* runPreCompactHook(true, opts);
    const result = await contextManager.compact(provider, model, signal, {
      aggressive: true,
      fingerprints,
      toolDefinitions,
      ...(precomputedSummary !== undefined ? { precomputedSummary } : {}),
    });
    if (result) {
      cumulativeOld ??= result.oldCount;
      cumulativeNew = result.newCount;
      phaseReached = 4;
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
      phase: phaseReached,
    };
  }

  const compacted = cumulativeOld !== null && cumulativeNew !== null;
  return { halt: contextManager.getUsagePercent() > HARD_CEILING, compacted };
}


/**
 * Run the PreCompact hook (if enabled). The hook receives `{ aggressive }`
 * on stdin and may return `{ additionalContext: "..." }` to override the
 * summary that compaction installs in place of the pruned messages. Errors
 * are surfaced as `hook-error` events but never block compaction.
 */
async function* runPreCompactHook(
  aggressive: boolean,
  opts: CompactionOptions | undefined,
): AsyncGenerator<AgentEvent, string | undefined> {
  if (!opts?.hooksEnabled || !opts.cwdRef) return undefined;
  try {
    const result = await runHook(
      'PreCompact',
      { aggressive },
      {
        cwd: opts.cwdRef.current,
        config: opts.hooksConfig,
        envPolicy: opts.envPolicy,
        onStderr: opts.onHookStderr,
      },
    );
    for (const e of result.errors) {
      opts.onHookError?.('PreCompact', e);
      yield { type: 'hook-error', event: 'PreCompact', error: e };
    }
    for (const hookCommand of result.firedCommands) {
      yield {
        type: 'hook-fired',
        event: 'PreCompact',
        hookCommand,
        ...(result.notice ? { notice: result.notice } : {}),
      };
    }
    return result.additionalContext;
  } catch (err: unknown) {
    const msg = errorMessage(err);
    opts.onHookError?.('PreCompact', msg);
    yield { type: 'hook-error', event: 'PreCompact', error: msg };
    return undefined;
  }
}
