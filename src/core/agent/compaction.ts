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
  if (!contextManager) return { halt: false };
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
      cumulativeOld = result.oldCount;
      cumulativeNew = result.newCount;
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
