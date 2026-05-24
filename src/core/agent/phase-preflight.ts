import type { Provider, TokenUsage } from '../../providers/types.js';
import type { ToolDefinition } from '../../tools/types.js';
import type { AgentEvent, AgentOptions } from './types.js';
import type { TurnExit } from './phase-types.js';
import type { ActivationFlags } from './reliability-config.js';
import { TOOL_NAMES } from '../../tools/types.js';
import { autoEnableForModel } from './reliability-config.js';
import { maybeCompact } from './compaction.js';
import { errorMessage, isError } from '../../utils/errors.js';

export interface PreflightSuccess {
  outcome: null;
  activation: ActivationFlags;
  /** Undefined when `useTextToolFallback` is on. */
  toolDefinitions: ToolDefinition[] | undefined;
}

export interface PreflightFailure {
  outcome: TurnExit;
}

/** Per-iteration pre-flight: re-read activation (rotation may have
 *  swapped models), build the per-turn tool-definition list, run
 *  compaction, emit `pre-turn-stats`.
 *
 *  Returns either the data the rest of the iteration needs
 *  (`PreflightSuccess`) or a `done` outcome the outer loop finalizes
 *  (`PreflightFailure`). Compaction-error and token-limit paths surface
 *  as outcomes here rather than throwing; the outer try/catch is
 *  reserved for the model-call / tool-execution segment of the loop.
 *
 *  Side effect: clears `responsesChainRef` when compaction rewrote
 *  messages. The ref is a shared mutable holder passed in by the caller
 *  (the chain pointer's `messageCount` would alias into rewritten
 *  history server-side otherwise); keeping the invalidation co-located
 *  with the cause avoids a "caller forgot to invalidate" failure mode. */
export async function* runPreflight(
  options: AgentOptions,
  state: { provider: Provider; model: string; lastUsage: TokenUsage | undefined },
): AsyncGenerator<AgentEvent, PreflightSuccess | PreflightFailure> {
  const { provider, model } = state;
  const useTextToolFallback = options.useTextToolFallback ?? false;
  const hooksEnabled = options.experimental?.hooks ?? false;
  const fileCache = options.experimental?.readCache ? options.fileCache : undefined;

  const activation = autoEnableForModel(provider, model);
  const wireExclude = activation.useRespondTool ? undefined : new Set<string>([TOOL_NAMES.Respond]);
  const toolDefinitions = useTextToolFallback
    ? undefined
    : options.toolRegistry.getDefinitions(wireExclude ? { exclude: wireExclude } : undefined);

  let compaction;
  try {
    compaction = yield* maybeCompact(
      options.contextManager,
      provider,
      model,
      options.signal,
      fileCache,
      {
        hooksEnabled,
        cwdRef: options.cwdRef,
        hooksConfig: options.hooksConfig,
        envPolicy: options.envPolicy,
        onHookStderr: options.onHookStderr,
        onHookError: options.onHookError,
        toolDefinitions,
      },
    );
  } catch (err: unknown) {
    if (options.signal?.aborted || (isError(err) && err.name === 'AbortError')) {
      return { outcome: { kind: 'done', stopReason: 'user-abort' } };
    }
    return {
      outcome: {
        kind: 'done',
        stopReason: 'error',
        error: isError(err) ? err : new Error(errorMessage(err)),
      },
    };
  }

  if (compaction.halt) {
    return { outcome: { kind: 'done', stopReason: 'token-limit' } };
  }

  // Compaction rewrites prior messages in place — any cached pointer
  // into the conversation index (e.g. ResponsesChain.messageCount)
  // would slice into mismatched history server-side. Drop it.
  if (compaction.compacted) {
    options.responsesChainRef?.set(undefined);
  }

  // Snapshot of what's about to be sent — recorded so session logs can
  // be graphed for context growth, not surfaced in the UI.
  if (options.contextManager) {
    yield {
      type: 'pre-turn-stats',
      tokenEstimate: options.contextManager.getTokenEstimate(),
      messageCount: options.conversation.getMessages().length,
      percentOfWindow: options.contextManager.getUsagePercent(),
    };
  }

  return { outcome: null, activation, toolDefinitions };
}
