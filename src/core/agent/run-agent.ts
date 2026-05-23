import type { ChatMessage, Provider, ToolCallMessage, TokenUsage } from '../../providers/types.js';
import type { ToolDefinition } from '../../utils/tool-definition.js';
import type { AgentEvent, AgentOptions, ResponsesChain } from './types.js';
import type { Conversation } from '../context/conversation.js';
import type { ContextManager } from '../context/context-manager.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { RecoveryState } from './recovery-state.js';
import { callModel } from './call-model/call-model.js';
import { parseModelResponse } from './parse-response.js';
import { runToolCalls } from './tool-calls/run-tool-calls.js';
import { maybeCompact } from './compaction.js';
import { BashDedupTracker } from './tool-calls/bash-dedup.js';
import { runHook } from '../hooks/index.js';
import { errorMessage, isError } from '../../utils/errors.js';
import { TOOL_NAMES } from '../../utils/tool-names.js';
import { autoEnableForModel, logActivation } from './reliability-config.js';
import { validateResponse } from './validator.js';
import { StepEnforcer, collectPrereqs } from './step-enforcer.js';
import { StepEnforcementError, PrerequisiteError, ToolExecutionError } from './errors.js';

const AUTO_RETRY_BUDGET = 3;
const MAX_CORRECTIONS_PER_RUN = 5;

function hasAnyPrereqs(defs: ToolDefinition[]): boolean {
  for (const d of defs) {
    if (d.prerequisites && d.prerequisites.length > 0) return true;
  }
  return false;
}

/** Persist a Responses-API chain pointer onto the caller's mutable
 *  ref. The `messageCount` is captured AFTER the assistant message
 *  was appended so the next call slices off exactly what the server
 *  has stored. No-op when `responseId` or `chainRef` is missing —
 *  not every provider speaks the Responses API. */
function captureChainPointer(
  chainRef:
    | { get(): ResponsesChain | undefined; set(value: ResponsesChain | undefined): void }
    | undefined,
  responseId: string | undefined,
  conversation: Conversation,
  provider: Provider,
  model: string,
  activeKeyId: string | undefined,
): void {
  if (!responseId || !chainRef) return;
  chainRef.set({
    lastResponseId: responseId,
    messageCount: conversation.getMessages().length,
    provider: provider.name,
    model,
    ...(activeKeyId ? { keyId: activeKeyId } : {}),
  });
}

/** Phase 5 clean-batch reset + Phase 14 step-completion emission.
 *  Called when the batch ran without denials or tool failures: resets
 *  the step enforcer's per-batch counters and yields one
 *  `step-completed` event per required-step name that's newly
 *  satisfied. The `emittedStepCompletions` set tracks which names
 *  we've already surfaced so a counter reset later in the run doesn't
 *  re-emit them. */
async function* settleCleanBatch(
  stepEnforcer: StepEnforcer,
  requiredSteps: readonly string[] | undefined,
  emittedStepCompletions: Set<string>,
): AsyncGenerator<AgentEvent> {
  stepEnforcer.resetCounters();
  const pending = new Set(stepEnforcer.pending());
  for (const name of requiredSteps ?? []) {
    if (!pending.has(name) && !emittedStepCompletions.has(name)) {
      emittedStepCompletions.add(name);
      yield { type: 'step-completed', tool: name };
    }
  }
}

/** True when the consecutive-hard-error budget is exhausted AND we
 *  have a recorded tool name + message to raise with. Both conditions
 *  matter — a counter trip without a recorded tool would only happen
 *  on a logic bug, but we tolerate it by falling through. */
function isHardErrorBudgetExhausted(recovery: RecoveryState): boolean {
  return (
    recovery.consecutiveHardToolErrors > recovery.maxHardToolErrors &&
    recovery.lastHardToolName !== null &&
    recovery.lastHardToolMessage !== null
  );
}

interface RespondShortCircuitInput {
  toolCalls: ToolCallMessage[];
  activation: { useRespondTool: boolean };
  stepEnforcer: StepEnforcer | undefined;
  terminalTools: readonly string[] | undefined;
}

/** Returns the Respond message when the batch is a single Respond call
 *  AND the step enforcer wouldn't gate it; otherwise null. Pure — no
 *  side effects. The agent loop emits the events and turn-complete; we
 *  just identify the case. */
function detectRespondShortCircuit(input: RespondShortCircuitInput): string | null {
  if (!input.activation.useRespondTool) return null;
  if (input.toolCalls.length !== 1) return null;
  const tc = input.toolCalls[0]!;
  if (tc.function?.name !== TOOL_NAMES.Respond) return null;
  // Step-enforcement carve-out: when an enforcer is configured AND
  // requiredSteps haven't completed yet AND Respond is one of the
  // terminal tools the scripted caller flagged, skip the short-circuit
  // so the enforcer's premature-terminal check can emit a step nudge.
  if (
    input.stepEnforcer &&
    input.stepEnforcer.getTracker().pending().length > 0 &&
    (input.terminalTools?.includes(TOOL_NAMES.Respond) ?? false)
  ) {
    return null;
  }
  return typeof tc.function?.arguments?.message === 'string'
    ? (tc.function.arguments.message as string)
    : '';
}

interface NoToolCallsInput {
  activation: { useRespondTool: boolean };
  storedContent: string;
  fullContent: string;
  lastUsage: TokenUsage | undefined;
  recovery: RecoveryState;
  conversation: Conversation;
  toolRegistry: ToolRegistry;
}

/** Handle the "model returned no tool calls" path. Three branches:
 *    1. weak-tier text-only with budget → retry-nudge injected, return 'retry'
 *    2. prior tool failure + budget → corrective user message, return 'retry'
 *    3. natural completion → emit auto-retry-exhausted (if applicable) and
 *       return 'complete'; caller fires the Stop hook + turn-complete.
 *
 *  Also yields the silent-turn warning when the model burned 100+
 *  completion tokens with no visible content. Extracted from the
 *  runAgent body to keep the outer generator under the per-function
 *  line cap. */
async function* handleNoToolCallsBranch(
  input: NoToolCallsInput,
): AsyncGenerator<AgentEvent, 'retry' | 'complete'> {
  const {
    activation,
    storedContent,
    fullContent,
    lastUsage,
    recovery,
    conversation,
    toolRegistry,
  } = input;
  // Reliability path (Phase 4 validator): weak-tier + text-only with
  // any content → inject a retry-nudge and re-loop.
  if (activation.useRespondTool && storedContent.trim().length > 0) {
    const validation = validateResponse([], storedContent, {
      toolNames: new Set(toolRegistry.getNames()),
      enforceToolCall: true,
    });
    if (validation.needsRetry && validation.nudge && recovery.autoRetryBudget > 0) {
      recovery.autoRetryBudget--;
      conversation.addUser(validation.nudge.content, { type: 'retry_nudge' });
      yield {
        type: 'auto-retry-injected',
        remainingBudget: recovery.autoRetryBudget,
        reason: validation.nudge.kind,
      };
      return 'retry';
    }
  }
  // Detect "silent" turns where the model burned tokens producing
  // nothing — typical of reasoning-block runaway on thinking-mode
  // models. Without this notice the spinner stops with no output.
  if (!fullContent && lastUsage && lastUsage.completionTokens >= 100) {
    yield { type: 'empty-turn-warning', completionTokens: lastUsage.completionTokens };
  }
  if (recovery.lastFailureMessage && recovery.autoRetryBudget > 0) {
    recovery.autoRetryBudget--;
    conversation.addUser(
      `Your last tool call failed with: "${recovery.lastFailureMessage}". Diagnose the cause and emit a corrected tool call now. Do not reply with prose.`,
    );
    yield {
      type: 'auto-retry-injected',
      remainingBudget: recovery.autoRetryBudget,
      reason: recovery.lastFailureMessage,
    };
    return 'retry';
  }
  if (recovery.lastFailureMessage) {
    yield { type: 'auto-retry-exhausted' };
  }
  return 'complete';
}

/** Emit the matching observability event (prereq / step) when the
 *  StepEnforcer's pre-computed checks fired. Returns which kind fired
 *  (or null) so the caller knows whether to `continue` the loop. Pure
 *  side-effect on events — does NOT re-invoke the enforcer (the agent
 *  loop already did so once to avoid double-counting the per-batch
 *  violation budget). */
async function* emitEnforcerObservability(
  toolCalls: ToolCallMessage[],
  prereqCheck: { nudge?: { meta?: { attemptedTool?: string; missing?: readonly string[] } } },
  stepCheck: { nudge?: { tier: 1 | 2 | 3 } } | null,
  terminalTools: readonly string[] | undefined,
  enforcer: StepEnforcer,
): AsyncGenerator<AgentEvent, 'prereq' | 'step' | null> {
  if (prereqCheck.nudge) {
    const meta = prereqCheck.nudge.meta;
    const fallbackOffender = toolCalls.find(tc => tc.function?.name !== undefined);
    yield {
      type: 'prerequisite-nudge',
      tool: meta?.attemptedTool ?? fallbackOffender?.function?.name ?? '<unknown>',
      missing: meta?.missing ? [...meta.missing] : [],
    };
    return 'prereq';
  }
  if (stepCheck?.nudge) {
    const attemptedTerminal = toolCalls.find(tc => {
      const n = tc.function?.name;
      return typeof n === 'string' && terminalTools?.includes(n);
    });
    yield {
      type: 'step-nudge',
      tier: stepCheck.nudge.tier,
      attemptedTool: attemptedTerminal?.function?.name ?? '<unknown>',
      pending: enforcer.pending(),
    };
    return 'step';
  }
  return null;
}

/** Pull a usable Responses-API chain pointer off the ref if its
 *  (provider, model, keyId, messageCount) tuple still matches the
 *  live call shape. Returns undefined when the pointer is stale or
 *  absent — caller falls back to a fresh request. Stale pointers are
 *  silently dropped rather than retried. */
function resolveChainPointer(
  chainRef:
    | { get(): ResponsesChain | undefined; set(value: ResponsesChain | undefined): void }
    | undefined,
  providerName: string,
  model: string,
  activeKeyId: string | undefined,
  messagesLen: number,
): { lastResponseId: string; messageCount: number } | undefined {
  const candidate = chainRef?.get();
  if (!candidate) return undefined;
  if (candidate.provider !== providerName) return undefined;
  if (candidate.model !== model) return undefined;
  if (candidate.keyId !== activeKeyId) return undefined;
  if (candidate.messageCount > messagesLen) return undefined;
  return {
    lastResponseId: candidate.lastResponseId,
    messageCount: candidate.messageCount,
  };
}

/** Phase 7 context-warning injection. Returns the message list as-is
 *  when no warning fires, or appended with a transient user-role
 *  warning otherwise. The warning is NOT persisted in conversation
 *  history — it lives only in the outbound payload for this one
 *  call. */
async function* maybeInjectContextWarning(
  messages: ChatMessage[],
  contextManager: ContextManager | undefined,
): AsyncGenerator<AgentEvent, ChatMessage[]> {
  if (!contextManager) return messages;
  const warning = contextManager.checkThresholds();
  if (!warning) return messages;
  yield {
    type: 'context-warning',
    thresholdPct: contextManager.getUsagePercent(),
    tokens: contextManager.getTokenEstimate(),
    warning,
  };
  return [...messages, { role: 'user' as const, content: warning }];
}

/** UserPromptSubmit fires once per runAgent call, before the user message
 *  enters the model loop. Return value is informational only — we log
 *  errors but don't act on `cancel` here (a vetoed user prompt would be
 *  surprising; users can just press Esc). Extracted from the runAgent
 *  generator body to keep that function under the per-function line cap. */
async function* fireUserPromptSubmit(
  userInput: string,
  options: AgentOptions,
  provider: Provider,
  model: string,
  conversation: Conversation,
): AsyncGenerator<AgentEvent> {
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

/** Build the StepEnforcer for a run if the AgentOptions opted in to any of:
 *  requiredSteps, terminalTools, or tool-declared prerequisites. Returns
 *  undefined for the common case so the agent loop's checks short-circuit. */
function buildStepEnforcer(
  options: AgentOptions,
  toolRegistry: AgentOptions['toolRegistry'],
): StepEnforcer | undefined {
  const hasRequired = !!options.requiredSteps && options.requiredSteps.length > 0;
  const hasTerminal = !!options.terminalTools && options.terminalTools.length > 0;
  if (!hasRequired && !hasTerminal && !hasAnyPrereqs(toolRegistry.getDefinitions())) {
    return undefined;
  }
  return new StepEnforcer({
    requiredSteps: options.requiredSteps ?? [],
    terminalTools: options.terminalTools ?? [],
    prereqs: collectPrereqs(toolRegistry.getDefinitions()),
  });
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
  const stepEnforcer = buildStepEnforcer(options, toolRegistry);

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
    // response when usage stays over the hard ceiling.
    //
    // Re-read activation per turn — rotation may have swapped to a model
    // in a different tier mid-run.
    const activation = autoEnableForModel(provider, model);
    const wireExclude = activation.useRespondTool
      ? undefined
      : new Set<string>([TOOL_NAMES.Respond]);
    const toolDefinitions = useTextToolFallback
      ? undefined
      : toolRegistry.getDefinitions(wireExclude ? { exclude: wireExclude } : undefined);
    let compaction;
    try {
      compaction = yield* maybeCompact(contextManager, provider, model, signal, fileCache, {
        hooksEnabled,
        cwdRef: options.cwdRef,
        hooksConfig: options.hooksConfig,
        envPolicy: options.envPolicy,
        onHookStderr: options.onHookStderr,
        onHookError: options.onHookError,
        toolDefinitions,
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
    // Compaction rewrites prior messages in place — any cached pointer
    // into the conversation index (e.g. ResponsesChain.messageCount)
    // would slice into mismatched history server-side. Drop it.
    if (compaction.compacted) {
      options.responsesChainRef?.set(undefined);
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

    let messages = conversation.getMessages();
    const tools = toolDefinitions;
    messages = yield* maybeInjectContextWarning(messages, contextManager);

    let fullContent = '';
    let toolCalls: ToolCallMessage[] = [];

    const chainRef = options.responsesChainRef;
    const chainForCall = resolveChainPointer(
      chainRef,
      provider.name,
      model,
      options.rotation?.activeKeyId,
      messages.length,
    );

    try {
      // Phase 13/16: thread the activation's `forceToolCall` into the
      // per-call ChatOptions. Anthropic honors this as `tool_choice:
      // "any"`; other providers ignore. The auto-enable rule in
      // reliability-config.ts only turns this on for weak-tier
      // Anthropic models — frontier models keep their natural text
      // path.
      const baseChatOptions: Record<string, unknown> = {};
      if (chainForCall) baseChatOptions.responsesChain = chainForCall;
      if (activation.forceToolCall && tools && tools.length > 0) {
        baseChatOptions.forceToolCall = true;
      }
      const modelResult = yield* callModel(provider, model, messages, tools, {
        signal,
        ...(options.rotation ? { rotation: options.rotation } : {}),
        ...(Object.keys(baseChatOptions).length > 0 ? { chatOptions: baseChatOptions } : {}),
      });
      if (modelResult.finalProvider) {
        provider = modelResult.finalProvider;
        options.rotation?.onProviderChange?.(provider);
        // Tier-2 rotation: the chain belongs to the previous (provider,
        // model) tuple. The validity check above would also drop it on the
        // next iteration; clearing here keeps state consistent for any
        // downstream introspection.
        chainRef?.set(undefined);
      }
      if (modelResult.finalModel) {
        model = modelResult.finalModel;
        options.rotation?.onModelChange?.(model);
        chainRef?.set(undefined);
      }
      fullContent = modelResult.fullContent;
      toolCalls = modelResult.toolCalls;
      if (modelResult.lastUsage) lastUsage = modelResult.lastUsage;
      // Optional `?.` even though the method is declared — `runAgent` is
      // hosted by external callers (TUI tabs, headless mode, future SDK
      // consumers) that may pass partial ContextManager stubs. Don't strip
      // it as "dead code"; the type system can't see those callers.
      contextManager?.recordPromptUsage?.(modelResult.lastUsage);

      // User aborted mid-stream: preserve whatever was already produced as
      // both a committed text-done event and a real assistant message so the
      // partial content stays visible in scrollback and in conversation
      // history.
      if (modelResult.aborted) {
        // Partial assistant content lands in conversation history below;
        // a chain pointer would then slice into a half-recorded turn on
        // the next call. Drop it BEFORE the addAssistant.
        chainRef?.set(undefined);
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

      // Synthetic Respond short-circuit. See detectRespondShortCircuit
      // for the predicate; when it returns a string the caller emits
      // the events and turn-completes here.
      const respondMessage = detectRespondShortCircuit({
        toolCalls,
        activation,
        stepEnforcer,
        terminalTools: options.terminalTools,
      });
      if (respondMessage !== null) {
        yield { type: 'respond-stripped', message: respondMessage };
        if (respondMessage) yield { type: 'text-done', fullContent: respondMessage };
        conversation.addAssistant(respondMessage);
        captureChainPointer(
          chainRef,
          modelResult.responseId,
          conversation,
          provider,
          model,
          options.rotation?.activeKeyId,
        );
        yield* fireStopHook(options, turnsUsed, 'completed');
        yield { type: 'turn-complete', stopReason: 'completed', turnsUsed, usage: lastUsage };
        return;
      }

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

      // Provider blocked or refused the response. The `doneReason` set is
      // narrow and provider-specific — keep this branch in sync with the
      // event-type docs above when a new provider starts emitting a
      // refusal/filter signal.
      //   OpenAI:    `content_filter` — output classified as policy-violating.
      //   Anthropic: `refusal`        — Claude declined mid-turn (4.x).
      if (modelResult.doneReason === 'content_filter' || modelResult.doneReason === 'refusal') {
        yield { type: 'output-blocked', reason: modelResult.doneReason };
      }

      const useUserResultFraming = !nativeToolSupport || recoveredFromText;
      conversation.addAssistant(
        storedContent,
        !useUserResultFraming && toolCalls.length > 0 ? toolCalls : undefined,
      );

      captureChainPointer(
        chainRef,
        modelResult.responseId,
        conversation,
        provider,
        model,
        options.rotation?.activeKeyId,
      );

      if (toolCalls.length === 0) {
        const outcome = yield* handleNoToolCallsBranch({
          activation,
          storedContent,
          fullContent,
          lastUsage,
          recovery,
          conversation,
          toolRegistry,
        });
        if (outcome === 'retry') continue;
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

      // Phase 5 enforcement: run BEFORE tool execution so a premature
      // terminal or unmet prereq becomes a nudge rather than a
      // wasted tool call. The model's attempted tool_call is already
      // in conversation history (addAssistant above) — emitting the
      // corrective user-role nudge alongside it is exactly the
      // "skeleton + nudge" shape the spec prescribes (§7).
      if (stepEnforcer) {
        try {
          // Compute the nudge content BEFORE yielding observability —
          // checkPrerequisites/check mutate counters, so calling them
          // inside the helper and again in the predicate would double-count.
          const prereqCheck = stepEnforcer.checkPrerequisites(toolCalls);
          if (prereqCheck.nudge) {
            conversation.addUser(prereqCheck.nudge.content, { type: 'prerequisite_nudge' });
          }
          const stepCheck = !prereqCheck.nudge ? stepEnforcer.check(toolCalls) : null;
          if (stepCheck?.nudge) {
            conversation.addUser(stepCheck.nudge.content, { type: 'step_nudge' });
          }
          const which = yield* emitEnforcerObservability(
            toolCalls,
            prereqCheck,
            stepCheck,
            options.terminalTools,
            stepEnforcer,
          );
          if (which !== null) continue;
        } catch (err: unknown) {
          if (err instanceof StepEnforcementError || err instanceof PrerequisiteError) {
            yield { type: 'error', error: err };
            yield* fireStopHook(options, turnsUsed, 'error');
            yield { type: 'turn-complete', stopReason: 'error', turnsUsed, usage: lastUsage };
            return;
          }
          throw err;
        }
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
          ...(stepEnforcer ? { stepEnforcer } : {}),
        },
        callSignature,
        recovery,
      );

      if (stepEnforcer && deniedCount === 0 && !recovery.lastFailureMessage) {
        yield* settleCleanBatch(stepEnforcer, options.requiredSteps, emittedStepCompletions);
      }

      // Phase 6: hard-error bailout — over the consecutive-throws budget.
      if (isHardErrorBudgetExhausted(recovery)) {
        const err = new ToolExecutionError(
          recovery.lastHardToolName!,
          recovery.lastHardToolMessage!,
        );
        yield { type: 'error', error: err };
        yield* fireStopHook(options, turnsUsed, 'error');
        yield { type: 'turn-complete', stopReason: 'error', turnsUsed, usage: lastUsage };
        return;
      }

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
