import type { ToolCallMessage, TokenUsage } from '../../providers/types.js';
import type { AgentEvent, AgentOptions } from './types.js';
import { RecoveryState } from './recovery-state.js';
import { callModel } from './call-model.js';
import { parseModelResponse } from './parse-response.js';
import { runToolCalls } from './run-tool-calls.js';
import { maybeCompact } from './compaction.js';
import { BashDedupTracker } from './bash-dedup.js';
import { runHook } from '../hooks/index.js';
import { errorMessage, isError } from '../../utils/errors.js';

const AUTO_RETRY_BUDGET = 3;
const MAX_CORRECTIONS_PER_RUN = 5;

/** Fire the Stop or StopFailure hook before each turn-complete yield. Stop
 *  fires on `stopReason: 'completed'`; StopFailure fires on every other
 *  reason (error, token-limit, user-abort) so hook authors can scope a
 *  matcher to "the run actually finished" vs "it bailed". Yields
 *  hook-fired/error events for the host. */
async function* fireStopHook(
  options: AgentOptions,
  turnsUsed: number,
  stopReason: string,
): AsyncGenerator<AgentEvent> {
  if (!options.experimental?.hooks) return;
  const event: 'Stop' | 'StopFailure' = stopReason === 'completed' ? 'Stop' : 'StopFailure';
  const cwd = options.cwdRef?.current ?? process.cwd();
  try {
    const result = await runHook(
      event,
      { turnsUsed, stopReason },
      {
        cwd,
        config: options.hooksConfig,
        envPolicy: options.envPolicy,
        onStderr: options.onHookStderr,
      },
    );
    for (const e of result.errors) {
      options.onHookError?.(event, e);
      yield { type: 'hook-error', event, error: e };
    }
    for (const hookCommand of result.firedCommands) {
      yield {
        type: 'hook-fired',
        event,
        hookCommand,
        ...(result.notice ? { notice: result.notice } : {}),
      };
    }
  } catch (err: unknown) {
    const msg = errorMessage(err);
    options.onHookError?.(event, msg);
    yield { type: 'hook-error', event, error: msg };
  }
}

// eslint-disable-next-line max-statements, complexity, sonarjs/cognitive-complexity -- TODO(complexity): extract step phases (plan / tool / model / hook).
export async function* runAgent(
  userInput: string,
  options: AgentOptions,
): AsyncGenerator<AgentEvent> {
  const { conversation, permissions, toolRegistry, contextManager, signal } = options;
  // Provider/model can be swapped mid-turn by rotation; subsequent
  // compactions and model calls in the same run must see the rotated
  // instance, not the stale one we started with.
  let provider = options.provider;
  let model = options.model;
  const useTextToolFallback = options.useTextToolFallback ?? false;
  const nativeToolSupport = options.nativeToolSupport ?? true;
  const planMode = options.planMode ?? false;
  const enableCorrector = options.enableCorrector ?? true;

  if (signal?.aborted) {
    yield { type: 'turn-complete', stopReason: 'user-abort', turnsUsed: 0 };
    return;
  }

  conversation.addUser(userInput);

  let turnsUsed = 0;
  let lastUsage: TokenUsage | undefined;
  const recovery = new RecoveryState(AUTO_RETRY_BUDGET, MAX_CORRECTIONS_PER_RUN);
  const bashDedup = options.experimental?.bashDedup ? new BashDedupTracker() : undefined;
  const fileCache = options.experimental?.readCache ? options.fileCache : undefined;
  const hooksEnabled = options.experimental?.hooks ?? false;

  // UserPromptSubmit fires once per runAgent call, before the user message is
  // sent into the model loop. Return value is informational only — we log
  // errors but don't act on `cancel` here (a vetoed user prompt would be
  // surprising; users can just press Esc).
  if (hooksEnabled) {
    try {
      // UserPromptSubmit fires before any tools have run, so cwdRef.current
      // (if supplied) still equals process.cwd() at this point. Fresh read
      // anyway to keep the pattern uniform with PreToolUse/PostToolUse,
      // which DO need it live (Bash `cd` may have updated cwdRef mid-turn).
      const cwd = options.cwdRef?.current ?? process.cwd();
      const result = await runHook(
        'UserPromptSubmit',
        { userInput, model, provider: provider.name },
        {
          cwd,
          config: options.hooksConfig,
          envPolicy: options.envPolicy,
          onStderr: options.onHookStderr,
        },
      );
      for (const e of result.errors) {
        options.onHookError?.('UserPromptSubmit', e);
        yield { type: 'hook-error', event: 'UserPromptSubmit', error: e };
      }
      for (const hookCommand of result.firedCommands) {
        yield {
          type: 'hook-fired',
          event: 'UserPromptSubmit',
          hookCommand,
          ...(result.notice ? { notice: result.notice } : {}),
        };
      }
      // Inject the hook's additionalContext as a follow-up user message so
      // the model sees it before answering. Distinct from the original user
      // input so a transcript still shows what the user actually typed.
      if (result.additionalContext) {
        conversation.addUser(result.additionalContext);
      }
    } catch (err: unknown) {
      yield { type: 'hook-error', event: 'UserPromptSubmit', error: errorMessage(err) };
    }
  }

  while (true) {
    if (signal?.aborted) {
      yield* fireStopHook(options, turnsUsed, 'user-abort');
      yield { type: 'turn-complete', stopReason: 'user-abort', turnsUsed, usage: lastUsage };
      return;
    }

    // Pre-flight: shrink the prompt before sending it. Doing this after the
    // model call wastes a model invocation on a bloated prompt and surfaces no
    // response when usage stays over the hard ceiling.
    let compaction;
    try {
      compaction = yield* maybeCompact(contextManager, provider, model, signal, fileCache, {
        hooksEnabled,
        cwdRef: options.cwdRef,
        hooksConfig: options.hooksConfig,
        envPolicy: options.envPolicy,
        onHookStderr: options.onHookStderr,
        onHookError: options.onHookError,
      });
    } catch (err: unknown) {
      if (signal?.aborted || (isError(err) && err.name === 'AbortError')) {
        yield* fireStopHook(options, turnsUsed, 'user-abort');
        yield { type: 'turn-complete', stopReason: 'user-abort', turnsUsed, usage: lastUsage };
        return;
      }
      yield { type: 'error', error: isError(err) ? err : new Error(errorMessage(err)) };
      yield* fireStopHook(options, turnsUsed, 'error');
      yield { type: 'turn-complete', stopReason: 'error', turnsUsed, usage: lastUsage };
      return;
    }
    if (compaction.halt) {
      yield* fireStopHook(options, turnsUsed, 'token-limit');
      yield { type: 'turn-complete', stopReason: 'token-limit', turnsUsed, usage: lastUsage };
      return;
    }

    // Snapshot of what's about to be sent — recorded so session logs can be
    // graphed for context growth, not surfaced in the UI.
    if (contextManager) {
      yield {
        type: 'pre-turn-stats',
        tokenEstimate: contextManager.getTokenEstimate(),
        messageCount: conversation.getMessages().length,
        percentOfWindow: contextManager.getUsagePercent(),
      };
    }

    turnsUsed++;

    const messages = conversation.getMessages();
    const tools = useTextToolFallback ? undefined : toolRegistry.getDefinitions();

    let fullContent = '';
    let toolCalls: ToolCallMessage[] = [];

    try {
      const modelResult = yield* callModel(
        provider,
        model,
        messages,
        tools,
        signal,
        options.rotation,
      );
      if (modelResult.finalProvider) {
        provider = modelResult.finalProvider;
        options.rotation?.onProviderChange?.(provider);
      }
      if (modelResult.finalModel) {
        model = modelResult.finalModel;
        options.rotation?.onModelChange?.(model);
      }
      fullContent = modelResult.fullContent;
      toolCalls = modelResult.toolCalls;
      if (modelResult.lastUsage) lastUsage = modelResult.lastUsage;

      // User aborted mid-stream: preserve whatever was already produced as
      // both a committed text-done event and a real assistant message so the
      // partial content stays visible in scrollback and in conversation
      // history.
      if (modelResult.aborted) {
        if (fullContent) {
          yield { type: 'text-done', fullContent };
          conversation.addAssistant(fullContent);
        }
        yield* fireStopHook(options, turnsUsed, 'user-abort');
        yield { type: 'turn-complete', stopReason: 'user-abort', turnsUsed, usage: lastUsage };
        return;
      }

      const parsed = yield* parseModelResponse(
        fullContent,
        toolCalls,
        new Set(toolRegistry.getNames()),
      );
      toolCalls = parsed.toolCalls;
      const storedContent = parsed.storedContent;
      const recoveredFromText = parsed.recoveredFromText;

      if (fullContent) {
        yield { type: 'text-done', fullContent };
      }

      // TODO: evaluate whether to add an experimental LLM-as-judge hallucination check here
      // (second-pass call over fullContent + project-facts, behind a flag). Decide first
      // whether it's worth the cost/latency and false-positive risk before building it.

      // Provider hit its output cap (Ollama's num_predict). Surface it so the
      // user knows their response was truncated, not naturally finished.
      if (modelResult.doneReason === 'length' && lastUsage) {
        yield { type: 'output-cap-reached', completionTokens: lastUsage.completionTokens };
      }

      const useUserResultFraming = !nativeToolSupport || recoveredFromText;
      conversation.addAssistant(
        storedContent,
        !useUserResultFraming && toolCalls.length > 0 ? toolCalls : undefined,
      );

      if (toolCalls.length === 0) {
        // Detect "silent" turns where the model burned a meaningful number
        // of completion tokens but produced no visible content and no tool
        // calls — typically reasoning-block runaway on small thinking-mode
        // models. Without this notice the spinner just stops with no output.
        if (!fullContent && lastUsage && lastUsage.completionTokens >= 100) {
          yield { type: 'empty-turn-warning', completionTokens: lastUsage.completionTokens };
        }
        // Auto-retry only fires on real tool failures. Earlier we also retried
        // when the model described an action without emitting a tool call, but
        // that produced too many false positives (the model narrating after a
        // successful run, answering questions, etc.). Removed.
        // TODO: revisit narrated-action retry with a tighter trigger — e.g.
        // text ends in a cliffhanger (": " then EOS, "let me…", "I'll…") AND
        // zero tool calls AND the prior turn had at least one. Seen in the
        // wild after aggressive compaction on small Ollama models.
        const shouldRetry = !!recovery.lastFailureMessage && recovery.autoRetryBudget > 0;
        if (shouldRetry && recovery.lastFailureMessage) {
          recovery.autoRetryBudget--;
          conversation.addUser(
            `Your last tool call failed with: "${recovery.lastFailureMessage}". Diagnose the cause and emit a corrected tool call now. Do not reply with prose.`,
          );
          yield {
            type: 'auto-retry-injected',
            remainingBudget: recovery.autoRetryBudget,
            reason: recovery.lastFailureMessage,
          };
          continue;
        }
        if (recovery.lastFailureMessage) {
          yield { type: 'auto-retry-exhausted' };
        }
        yield* fireStopHook(options, turnsUsed, 'completed');
        yield { type: 'turn-complete', stopReason: 'completed', turnsUsed, usage: lastUsage };
        return;
      }

      const callSignature = toolCalls
        .map(tc => `${tc.function?.name}:${JSON.stringify(tc.function?.arguments ?? {})}`)
        .join('|');
      if (recovery.lastFailureSignature && callSignature === recovery.lastFailureSignature) {
        recovery.consecutiveSameFailures++;
      } else {
        recovery.consecutiveSameFailures = 0;
      }

      const { deniedCount } = yield* runToolCalls(
        toolCalls,
        {
          conversation,
          permissions,
          toolRegistry,
          signal,
          useUserResultFraming,
          planMode,
          enableCorrector,
          bashDedup,
          fileCache,
          provider,
          model,
          userInput,
          cwdRef: options.cwdRef,
          pathPolicy: options.pathPolicy,
          envPolicy: options.envPolicy,
          hooksEnabled,
          hooksConfig: options.hooksConfig,
          onHookStderr: options.onHookStderr,
          onHookError: options.onHookError,
        },
        callSignature,
        recovery,
      );

      // All tool calls in this turn were denied. The user is rejecting the
      // direction; don't keep prompting the model — halt and let them speak.
      if (!planMode && toolCalls.length > 0 && deniedCount === toolCalls.length) {
        yield { type: 'all-denied-halt', count: deniedCount };
        yield* fireStopHook(options, turnsUsed, 'completed');
        yield { type: 'turn-complete', stopReason: 'completed', turnsUsed, usage: lastUsage };
        return;
      }

      if (recovery.consecutiveSameFailures >= 2 && recovery.lastFailureMessage) {
        yield { type: 'auto-retry-exhausted' };
        yield* fireStopHook(options, turnsUsed, 'completed');
        yield { type: 'turn-complete', stopReason: 'completed', turnsUsed, usage: lastUsage };
        return;
      }
    } catch (err: unknown) {
      if (signal?.aborted || (isError(err) && err.name === 'AbortError')) {
        yield* fireStopHook(options, turnsUsed, 'user-abort');
        yield { type: 'turn-complete', stopReason: 'user-abort', turnsUsed, usage: lastUsage };
        return;
      }
      yield { type: 'error', error: isError(err) ? err : new Error(errorMessage(err)) };
      yield* fireStopHook(options, turnsUsed, 'error');
      yield { type: 'turn-complete', stopReason: 'error', turnsUsed, usage: lastUsage };
      return;
    }
  }
}
