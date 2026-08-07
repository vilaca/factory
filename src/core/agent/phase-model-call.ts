import type { ChatMessage, ToolCallMessage } from '../../providers/types.js';
import type { ToolDefinition } from '../../tools/host.js';
import type { ContextManager } from '../context/context-manager.js';
import type { AgentEvent, AgentOptions, ResponsesChain } from './types.js';
import type { TurnExit, TurnState } from './phase-types.js';
import type { ActivationFlags } from './reliability-config.js';
import { callModel } from './call-model/call-model.js';
import { parseModelResponse } from './parse-response.js';

/** Output of `callModel` reshaped for downstream phases. Carried out
 *  separately from `parsed` because the response-emission phase
 *  branches on `doneReason` and uses `responseId` for chain capture. */
interface ModelCallResultData {
  responseId: string | undefined;
  doneReason: string | undefined;
  fullContent: string;
}

interface ParsedResponse {
  toolCalls: ToolCallMessage[];
  storedContent: string;
  recoveredFromText: boolean;
}

export interface ModelCallSuccess {
  outcome: null;
  state: TurnState;
  result: ModelCallResultData;
  parsed: ParsedResponse;
}

export interface ModelCallFailure {
  outcome: TurnExit;
  /** Even on failure, `lastUsage` may have advanced (we update it from
   *  `modelResult` BEFORE the aborted check). The outer loop applies
   *  state THEN finalizes, so the turn-complete event carries the
   *  correct usage. */
  state: TurnState;
}

/** Phase B: model call + rotation handling + mid-stream abort handling
 *  + response parsing.
 *
 *  Inputs: `state.activation` and `state.toolDefinitions` come from the
 *  preflight phase; everything else from the loop's running state.
 *
 *  Returns:
 *  - `ModelCallSuccess` on the normal path — the loop applies `state`,
 *    then proceeds with `result` + `parsed` to the response-emission
 *    phase (not yet extracted).
 *  - `ModelCallFailure` only when the user aborted mid-stream. The
 *    partial assistant content has already been emitted as `text-done`
 *    and committed to conversation history by the phase, because a
 *    chain pointer captured by a later phase would otherwise alias
 *    into a half-recorded turn.
 *
 *  Unexpected throws (network, provider SDK, JSON) propagate to the
 *  outer try/catch in `runAgent`, as per the `TurnOutcome` contract. */
export async function* runModelCall(
  options: AgentOptions,
  state: TurnState & {
    activation: ActivationFlags;
    toolDefinitions: ToolDefinition[] | undefined;
  },
): AsyncGenerator<AgentEvent, ModelCallSuccess | ModelCallFailure> {
  const { activation, toolDefinitions: tools } = state;
  let provider = state.provider;
  let model = state.model;
  let lastUsage = state.lastUsage;

  const messages = yield* maybeInjectContextWarning(
    options.conversation.getMessages(),
    options.contextManager,
  );

  const chainRef = options.responsesChainRef;
  const chainForCall = resolveChainPointer(
    chainRef,
    provider.name,
    model,
    options.rotation?.activeKeyId,
    messages.length,
  );

  // Phase 13/16: thread the activation's `forceToolCall` into the
  // per-call ChatOptions. Anthropic honors this as `tool_choice: "any"`;
  // other providers ignore. The auto-enable rule in
  // reliability-config.ts only turns this on for weak-tier Anthropic
  // models — frontier models keep their natural text path.
  const baseChatOptions: Record<string, unknown> = {};
  if (chainForCall) baseChatOptions.responsesChain = chainForCall;
  if (activation.forceToolCall && tools && tools.length > 0) {
    baseChatOptions.forceToolCall = true;
  }

  const modelResult = yield* callModel(provider, model, messages, tools, {
    signal: options.signal,
    ...(options.rotation ? { rotation: options.rotation } : {}),
    ...(Object.keys(baseChatOptions).length > 0 ? { chatOptions: baseChatOptions } : {}),
  });

  if (modelResult.finalProvider) {
    provider = modelResult.finalProvider;
    options.rotation?.onProviderChange?.(provider);
    // Tier-2 rotation: the chain belongs to the previous (provider,
    // model) tuple. The validity check in `resolveChainPointer` would
    // also drop it on the next iteration; clearing here keeps state
    // consistent for any downstream introspection.
    chainRef?.set(undefined);
  }
  if (modelResult.finalModel) {
    model = modelResult.finalModel;
    options.rotation?.onModelChange?.(model);
    chainRef?.set(undefined);
  }
  const fullContent = modelResult.fullContent;
  if (modelResult.lastUsage) lastUsage = modelResult.lastUsage;
  // Optional `?.` even though the method is declared — `runAgent` is
  // hosted by external callers (TUI tabs, headless mode, future SDK
  // consumers) that may pass partial ContextManager stubs. Don't strip
  // it as "dead code"; the type system can't see those callers.
  options.contextManager?.recordPromptUsage?.(modelResult.lastUsage);

  // User aborted mid-stream: preserve whatever was already produced as
  // both a committed text-done event and a real assistant message so
  // the partial content stays visible in scrollback and in conversation
  // history. The chain pointer is dropped BEFORE the addAssistant
  // because a captured pointer would slice into a half-recorded turn
  // on the next call.
  if (modelResult.aborted) {
    chainRef?.set(undefined);
    if (fullContent) {
      yield { type: 'text-done', fullContent };
      options.conversation.addAssistant(fullContent);
    }
    return {
      outcome: { kind: 'done', stopReason: 'user-abort' },
      state: { provider, model, lastUsage },
    };
  }

  const parsed = yield* parseModelResponse(
    fullContent,
    modelResult.toolCalls,
    new Set(options.toolRegistry.getNames()),
  );

  return {
    outcome: null,
    state: { provider, model, lastUsage },
    result: {
      responseId: modelResult.responseId,
      doneReason: modelResult.doneReason,
      fullContent,
    },
    parsed,
  };
}

/** Phase 7 context-warning injection. Returns the message list as-is
 *  when no warning fires, or appended with a transient user-role
 *  warning otherwise. The warning is NOT persisted in conversation
 *  history — it lives only in the outbound payload for this one call. */
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

/** Pull a usable Responses-API chain pointer off the ref if its
 *  (provider, model, keyId, messageCount) tuple still matches the live
 *  call shape. Returns undefined when the pointer is stale or absent —
 *  caller falls back to a fresh request. Stale pointers are silently
 *  dropped rather than retried. */
function resolveChainPointer(
  chainRef:
    { get(): ResponsesChain | undefined; set(value: ResponsesChain | undefined): void } | undefined,
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
