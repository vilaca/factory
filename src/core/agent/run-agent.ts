import type { TokenUsage, ToolCallMessage } from '../../providers/types.js';
import type { AgentEvent, AgentOptions } from './types.js';
import { RecoveryState } from './recovery-state.js';
import { runToolCalls } from './tool-calls/run-tool-calls.js';
import type { ToolLoopContext } from './tool-calls/types.js';
import { BashDedupTracker } from './tool-calls/bash-dedup.js';
import { fireUserPromptSubmit, fireStopHook } from './hooks-runner.js';
import { errorMessage, isError } from '../../utils/errors.js';
import { autoEnableForModel, logActivation } from './reliability-config.js';
import { buildStepEnforcer } from './step-enforcer.js';
import { runPreflight } from './phase-preflight.js';
import { runModelCall } from './phase-model-call.js';
import { runResponseEmission } from './phase-response-emission.js';
import { runEnforcement } from './phase-enforcement.js';
import { runPostExecution } from './phase-post-execution.js';
import { runNoToolCalls } from './phase-no-tool-calls.js';
import { finalizeTurn } from './phase-types.js';

const AUTO_RETRY_BUDGET = 3;
const MAX_CORRECTIONS_PER_RUN = 5;

// TODO(complexity): runAgent trips max-statements (81/60), complexity (35/25),
//   and cognitive-complexity (43/30). The remaining excess is the setup block +
//   the `try/catch` branching around the six phase calls. Further extraction
//   wouldn't shrink the numbers — the branches *are* the orchestration this
//   file is meant to express. Lifting them into a phase that returns
//   `TurnOutcome` would just hide the dispatch table.
// eslint-disable-next-line max-statements, complexity, sonarjs/cognitive-complexity
export async function* runAgent(
  userInput: string,
  options: AgentOptions,
): AsyncGenerator<AgentEvent> {
  const { conversation, permissions, toolRegistry, signal } = options;
  // Provider/model can be swapped mid-turn by rotation; subsequent
  // compactions and model calls in the same run must see the rotated
  // instance, not the stale one we started with.
  let provider = options.provider;
  let model = options.model;
  const nativeToolSupport = options.nativeToolSupport ?? true;
  const planMode = options.planMode ?? false;
  const enableCorrector = options.enableCorrector ?? false;

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
  // Auto-enable per the reliability stack. `useRespondTool` flips on for
  // weak-tier models (Ollama small, llamacpp small, cheap cloud) so they
  // see the synthetic Respond tool. Frontier models route text naturally
  // and don't need it on the wire. The activation may change across the
  // turn if rotation swaps to a different (provider, model) tuple — read
  // it again then, not cached here.
  const initialActivation = autoEnableForModel(provider, model);
  logActivation(provider, model, initialActivation);
  // Track which required-step completions have already been surfaced
  // as `step-completed` events so we don't repeat them after a counter
  // reset.
  const emittedStepCompletions = new Set<string>();

  // Phase 5 step enforcer. Built once per agent run; lives outside the
  // conversation so compaction can't invalidate which steps completed.
  // Stays dormant for the general path — required/terminal sets are
  // empty by default and the prereq map is empty unless tools declared
  // any. The enforcer's checks short-circuit to "no nudge" when
  // there's nothing to enforce, so the cost on the common path is a
  // method call.
  const stepEnforcer = buildStepEnforcer({
    requiredSteps: options.requiredSteps,
    terminalTools: options.terminalTools,
    toolDefinitions: toolRegistry.getDefinitions(),
  });

  if (hooksEnabled) {
    yield* fireUserPromptSubmit(userInput, options, provider, model, conversation);
  }

  while (true) {
    if (signal?.aborted) {
      yield* fireStopHook(options, turnsUsed, 'user-abort');
      yield { type: 'turn-complete', stopReason: 'user-abort', turnsUsed, usage: lastUsage };
      return;
    }

    // Pre-flight: shrink the prompt before sending it. Doing this after the
    // model call wastes a model invocation on a bloated prompt and surfaces no
    // response when usage stays over the hard ceiling. Compaction's own error
    // / token-limit paths come back as `pre.outcome`; the outer try/catch
    // below only wraps the model-call + tool-execution segment.
    const pre = yield* runPreflight(options, { provider, model, lastUsage });
    if (pre.outcome) {
      yield* finalizeTurn(options, turnsUsed, lastUsage, pre.outcome);
      return;
    }
    const { activation, toolDefinitions } = pre;

    turnsUsed++;

    let fullContent = '';
    let toolCalls: ToolCallMessage[] = [];

    try {
      // Phase B: model call + rotation + mid-stream abort + parse.
      // Apply state updates BEFORE branching on outcome so the
      // finalize path (e.g. user-abort mid-stream) carries the
      // updated lastUsage.
      const call = yield* runModelCall(options, {
        provider,
        model,
        lastUsage,
        activation,
        toolDefinitions,
      });
      ({ provider, model, lastUsage } = call.state);
      if (call.outcome) {
        yield* finalizeTurn(options, turnsUsed, lastUsage, call.outcome);
        return;
      }
      const { responseId, doneReason, fullContent: callFullContent } = call.result;
      const parsed = call.parsed;
      fullContent = callFullContent;
      toolCalls = parsed.toolCalls;
      const storedContent = parsed.storedContent;
      const recoveredFromText = parsed.recoveredFromText;

      // Phase C: emit text-done / output-cap / output-blocked,
      // commit the assistant message, capture the chain pointer.
      // Returns a `done completed` outcome only on the Respond
      // short-circuit; otherwise falls through.
      const emit = yield* runResponseEmission(options, {
        responseId,
        doneReason,
        fullContent,
        toolCalls,
        storedContent,
        recoveredFromText,
        activation,
        stepEnforcer,
        provider,
        model,
        lastUsage,
        nativeToolSupport,
      });
      if (emit.outcome) {
        yield* finalizeTurn(options, turnsUsed, lastUsage, emit.outcome);
        return;
      }

      // TODO: evaluate whether to add an experimental LLM-as-judge hallucination check here
      // (second-pass call over fullContent + project-facts, behind a flag). Decide first
      // whether it's worth the cost/latency and false-positive risk before building it.

      if (toolCalls.length === 0) {
        const ntc = yield* runNoToolCalls(options, {
          activation,
          storedContent,
          fullContent,
          lastUsage,
          recovery,
        });
        if (ntc.kind === 'continue') continue;
        yield* finalizeTurn(options, turnsUsed, lastUsage, ntc);
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

      // Phase E: step enforcer pre-check. Runs only when an enforcer is
      // installed — the phase contract expects a non-undefined enforcer.
      if (stepEnforcer) {
        const enf = yield* runEnforcement(options, { toolCalls, stepEnforcer });
        if (enf.kind === 'continue') continue;
        if (enf.kind === 'done') {
          yield* finalizeTurn(options, turnsUsed, lastUsage, enf);
          return;
        }
      }

      const useUserResultFraming = !nativeToolSupport || recoveredFromText;
      // Named annotation (vs an inline literal) so an agent grep'ing for
      // `ToolLoopContext` finds the construction site and the contract in
      // one search. The annotation also catches drift: adding a required
      // field to the interface fails to compile here, with a clear
      // "missing field" error instead of an opaque "argument not assignable".
      const toolLoopCtx: ToolLoopContext = {
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
        ...(stepEnforcer ? { stepEnforcer } : {}),
      };
      const { deniedCount } = yield* runToolCalls(toolCalls, toolLoopCtx, callSignature, recovery);

      // Phase G: settleCleanBatch + hard-error / all-denied / same-
      // failure termination checks.
      const post = yield* runPostExecution(options, {
        toolCalls,
        deniedCount,
        recovery,
        stepEnforcer,
        planMode,
        emittedStepCompletions,
      });
      if (post) {
        yield* finalizeTurn(options, turnsUsed, lastUsage, post);
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
