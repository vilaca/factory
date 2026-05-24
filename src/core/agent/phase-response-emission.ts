import type { Provider, TokenUsage, ToolCallMessage } from '../../providers/types.js';
import type { Conversation } from '../context/conversation.js';
import type { AgentEvent, AgentOptions, ResponsesChain } from './types.js';
import type { TurnExit } from './phase-types.js';
import type { StepEnforcer } from './step-enforcer.js';
import type { ActivationFlags } from './reliability-config.js';
import { TOOL_NAMES } from '../../tools/types.js';

export interface ResponseEmissionInput {
  responseId: string | undefined;
  doneReason: string | undefined;
  fullContent: string;
  toolCalls: ToolCallMessage[];
  storedContent: string;
  recoveredFromText: boolean;
  activation: ActivationFlags;
  stepEnforcer: StepEnforcer | undefined;
  provider: Provider;
  model: string;
  lastUsage: TokenUsage | undefined;
  nativeToolSupport: boolean;
}

export interface ResponseEmissionResult {
  /** `null` ⇒ emission complete, loop proceeds to the no-tool-calls
   *  branch / enforcement / tool execution. A `done` outcome fires only
   *  on the Respond short-circuit. */
  outcome: TurnExit | null;
}

/** Phase C: emit the model's response into the event stream + history.
 *
 *  Sequence (any subset may fire, in this order):
 *  1. Respond short-circuit → emit respond-stripped + text-done +
 *     addAssistant + captureChainPointer, return `done completed`.
 *  2. text-done for the streamed content.
 *  3. output-cap-reached / output-blocked diagnostics derived from
 *     `doneReason`.
 *  4. addAssistant with the parsed storedContent + (optionally) the
 *     parsed tool calls.
 *  5. captureChainPointer for the next turn's Responses-API slice.
 *
 *  Pure-yield phase — no state mutations beyond `conversation` and the
 *  `responsesChainRef`. */
export async function* runResponseEmission(
  options: AgentOptions,
  input: ResponseEmissionInput,
): AsyncGenerator<AgentEvent, ResponseEmissionResult> {
  const chainRef = options.responsesChainRef;
  const conversation = options.conversation;

  // Synthetic Respond short-circuit. See detectRespondShortCircuit for
  // the predicate; when it returns a string the caller emits the events
  // and turn-completes here.
  const respondMessage = detectRespondShortCircuit({
    toolCalls: input.toolCalls,
    activation: input.activation,
    stepEnforcer: input.stepEnforcer,
    terminalTools: options.terminalTools,
  });
  if (respondMessage !== null) {
    yield { type: 'respond-stripped', message: respondMessage };
    if (respondMessage) yield { type: 'text-done', fullContent: respondMessage };
    conversation.addAssistant(respondMessage);
    captureChainPointer(
      chainRef,
      input.responseId,
      conversation,
      input.provider,
      input.model,
      options.rotation?.activeKeyId,
    );
    return { outcome: { kind: 'done', stopReason: 'completed' } };
  }

  if (input.fullContent) {
    yield { type: 'text-done', fullContent: input.fullContent };
  }

  // Provider hit its output cap (Ollama's num_predict). Surface it so
  // the user knows their response was truncated, not naturally finished.
  if (input.doneReason === 'length' && input.lastUsage) {
    yield { type: 'output-cap-reached', completionTokens: input.lastUsage.completionTokens };
  }

  // Provider blocked or refused the response. The `doneReason` set is
  // narrow and provider-specific — keep this branch in sync with the
  // event-type docs in `types.ts` when a new provider starts emitting a
  // refusal/filter signal.
  //   OpenAI:    `content_filter` — output classified as policy-violating.
  //   Anthropic: `refusal`        — Claude declined mid-turn (4.x).
  if (input.doneReason === 'content_filter' || input.doneReason === 'refusal') {
    yield { type: 'output-blocked', reason: input.doneReason };
  }

  const useUserResultFraming = !input.nativeToolSupport || input.recoveredFromText;
  conversation.addAssistant(
    input.storedContent,
    !useUserResultFraming && input.toolCalls.length > 0 ? input.toolCalls : undefined,
  );

  captureChainPointer(
    chainRef,
    input.responseId,
    conversation,
    input.provider,
    input.model,
    options.rotation?.activeKeyId,
  );

  return { outcome: null };
}

interface RespondShortCircuitInput {
  toolCalls: ToolCallMessage[];
  activation: { useRespondTool: boolean };
  stepEnforcer: StepEnforcer | undefined;
  terminalTools: readonly string[] | undefined;
}

/** Returns the Respond message when the batch is a single Respond call
 *  AND the step enforcer wouldn't gate it; otherwise null. Pure — no
 *  side effects. The phase emits the events and turn-completes; we
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

/** Persist a Responses-API chain pointer onto the caller's mutable ref.
 *  The `messageCount` is captured AFTER the assistant message was
 *  appended so the next call slices off exactly what the server has
 *  stored. No-op when `responseId` or `chainRef` is missing — not every
 *  provider speaks the Responses API. */
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
