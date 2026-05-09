import type {
  ChatChunk,
  ChatMessage,
  Provider,
  TokenUsage,
  ToolCallMessage,
  ToolDefinition,
} from '../../providers/types.js';
import type { AgentEvent, RotationOptions } from '../agent-types.js';
import { resolveRetryPolicy } from '../provider-retry.js';
import { RepeatDetector } from './repeat-detector.js';
import { applyCacheBoundaries } from './cache-boundaries.js';
import { errorMessage, isError } from '../../utils/errors.js';
import { tryRotation, type RotationState } from './call-model-rotation.js';
import { tryRetry } from './call-model-retry.js';

/**
 * Pump chat chunks into the rotation state, yielding text and repetition
 * events as they land. Returns when the iterator finishes; throws on the
 * caller's abort or on any iterator-side error (including provider rejections
 * that the caller will route through rotation).
 */
async function* streamIntoState(
  state: RotationState,
  iter: AsyncIterable<ChatChunk>,
  repeatDetector: RepeatDetector,
  internal: AbortController,
  signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent, void> {
  for await (const chunk of iter) {
    if (signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    if (chunk.content) {
      yield { type: 'text-chunk', content: chunk.content };
      state.fullContent += chunk.content;
      state.streamedAnything = true;
      const repeat = repeatDetector.feed(chunk.content);
      if (repeat) {
        yield { type: 'repetition-detected', line: repeat.line, streak: repeat.streak };
        internal.abort();
      }
    }
    if (chunk.tool_calls) {
      state.toolCalls.push(...sanitizeToolCalls(chunk.tool_calls));
      state.streamedAnything = true;
    }
    if (chunk.usage) {
      state.lastUsage = chunk.usage;
    }
    if (chunk.doneReason) {
      state.doneReason = chunk.doneReason;
    }
  }
}

/**
 * Recover from a stream-only failure by replaying the call non-streamed.
 * Mirrors what the streaming success path would have done — assigns the
 * response into state and yields the full content as a single text-chunk so
 * downstream rendering sees the same event shape either way.
 */
async function* recoverViaNonStream(
  state: RotationState,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent, void> {
  const response = await state.provider.chatNoStream(state.model, messages, tools, {
    signal,
    cacheTools: true,
  });
  state.fullContent = response.content ?? '';
  state.toolCalls = sanitizeToolCalls(response.tool_calls ?? []);
  if (response.usage) {
    state.lastUsage = response.usage;
  }
  if (state.fullContent) {
    yield { type: 'text-chunk', content: state.fullContent };
  }
}

function isAbortError(
  err: unknown,
  callerSignal: AbortSignal | undefined,
  internalSignal: AbortSignal,
): boolean {
  return (
    Boolean(callerSignal?.aborted) ||
    internalSignal.aborted ||
    (isError(err) && err.name === 'AbortError')
  );
}

// Errors that signal a streaming-channel hiccup rather than a model
// failure: we recover by replaying the call non-streamed once. Distinct
// from classifyForRetry's network bucket — those are connection-establish
// errors that warrant backoff+retry. These are mid-stream drops where
// chatNoStream usually delivers what the SSE channel couldn't.
function isStreamish(err: unknown): boolean {
  const msg = errorMessage(err);
  return (
    msg.includes('stream') ||
    msg.includes('connection dropped') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed')
  );
}

function sanitizeToolCalls(
  toolCalls: Array<ToolCallMessage | null | undefined>,
): ToolCallMessage[] {
  return toolCalls.flatMap(toolCall => {
    if (
      !toolCall?.function ||
      typeof toolCall.function.name !== 'string' ||
      !toolCall.function.name
    ) {
      return [];
    }

    const args = toolCall.function.arguments;
    return [
      {
        id: toolCall.id,
        function: {
          name: toolCall.function.name,
          arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
        },
      },
    ];
  });
}

interface ModelCallResult {
  fullContent: string;
  toolCalls: ToolCallMessage[];
  lastUsage: TokenUsage | undefined;
  /** True when the call was aborted by the user partway through. The fullContent
   * field carries whatever was already streamed so callers can preserve it. */
  aborted?: boolean;
  /** Provider-supplied stop reason from the final chunk (e.g. Ollama's
   * "length" when the response hit num_predict). */
  doneReason?: string;
  /** When rotation swapped the provider mid-call, this is the final
   *  provider used. Callers should adopt it for subsequent calls in the
   *  same turn (otherwise compaction or follow-up turns would use the
   *  stale, rate-limited provider). */
  finalProvider?: Provider;
  /** When tier-2 rotation swapped to a different (provider, model)
   *  tuple, this is the model the call ended on. */
  finalModel?: string;
}

/**
 * Stream a model response, yielding text-chunk events as they arrive.
 *
 * When streaming throws an error containing "stream" (a common signal that the
 * connection dropped, not that the model failed), retries non-streamed and
 * yields the result as a single text-chunk for downstream rendering parity.
 *
 * Abort and non-stream errors propagate to the orchestrator, which decides
 * how to surface them.
 */
export async function* callModel(
  initialProvider: Provider,
  initialModel: string,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  signal: AbortSignal | undefined,
  rotation?: RotationOptions,
): AsyncGenerator<AgentEvent, ModelCallResult> {
  const state: RotationState = {
    provider: initialProvider,
    model: initialModel,
    activeKeyId: rotation?.activeKeyId,
    activeKeys: rotation?.keys ?? [],
    // Per-call tried-set to prevent looping when every key 429s. Reset when
    // tier 2 advances to a new tuple — each tuple gets its own pool to walk.
    triedKeyIds: new Set<string>(rotation?.activeKeyId ? [rotation.activeKeyId] : []),
    // Tier-2 bookkeeping: track which (provider, model) tuples have already
    // been tried so we don't loop back to the original on chain advance.
    triedTuples: new Set<string>([`${initialProvider.name}:${initialModel}`]),
    tupleRotated: false,
    fullContent: '',
    toolCalls: [],
    lastUsage: undefined,
    doneReason: undefined,
    streamedAnything: false,
  };

  // Combine the user's abort signal with an internal one so we can also
  // abort from inside this loop (e.g. when a runaway-repetition pattern is
  // detected). When the user aborts, we cascade to the internal one too.
  const internal = new AbortController();
  const cascade = (): void => internal.abort();
  if (signal) {
    if (signal.aborted) internal.abort();
    else signal.addEventListener('abort', cascade, { once: true });
  }
  const cleanup = (): void => {
    if (signal) signal.removeEventListener('abort', cascade);
  };
  const repeatDetector = new RepeatDetector();

  // Annotate cache boundaries once per call. The marked array shares the
  // same shape as `messages` — non-Anthropic providers ignore the
  // cacheBoundary hint and Anthropic's splitMessagesForAnthropic
  // translates it into cache_control blocks.
  const annotated = applyCacheBoundaries(messages);
  const callOpts = { signal: internal.signal, cacheTools: true };

  // Per-key retry budget. Sits in front of rotation: a transient blip
  // (5xx, network drop, 408, 429) re-attempts on the same key with full-
  // jitter exponential backoff before we burn a rotation slot. Counter is
  // reset each time we successfully start a stream OR rotate — each
  // (provider, model, key) triple gets its own budget. The retry helper
  // (tryRetry above) is broken out so this loop stays under the
  // cognitive-complexity cap.
  const retryPolicy = resolveRetryPolicy();
  let retryAttempt = 0;

  // Rotation loop: on a rate-limit/auth failure *before* any chunk has
  // streamed, try the next saved key. Streaming losses still surface
  // because retrying mid-stream would replay tokens the caller already
  // committed to scrollback.
  while (true) {
    state.streamedAnything = false;
    try {
      const stream = state.provider.chat(state.model, annotated, tools, callOpts);
      yield* streamIntoState(state, stream, repeatDetector, internal, signal);
      break;
    } catch (err: unknown) {
      if (isAbortError(err, signal, internal.signal)) {
        cleanup();
        return {
          fullContent: state.fullContent,
          toolCalls: sanitizeToolCalls(state.toolCalls),
          lastUsage: state.lastUsage,
          aborted: true,
          doneReason: state.doneReason,
        };
      }
      // Same-key retry on a transient failure, BEFORE rotation. See
      // tryRetry() for the 429 vs 5xx vs network split.
      const retryOutcome = yield* tryRetry(
        err,
        retryAttempt,
        retryPolicy,
        rotation !== undefined,
        state.streamedAnything,
      );
      retryAttempt = retryOutcome.nextAttempt;
      if (retryOutcome.retried) continue;
      const rotationDecision = yield* tryRotation(state, rotation, err);
      if (rotationDecision.kind === 'rotated') {
        retryAttempt = 0;
        continue;
      }
      if (rotationDecision.kind === 'rethrow') {
        cleanup();
        throw rotationDecision.err;
      }
      // Stream-only failures and transient connection drops retry
      // non-streamed once on the same provider — the model usually has the
      // answer in non-streaming mode even when the SSE channel hiccups.
      if (isStreamish(err)) {
        yield* recoverViaNonStream(state, annotated, tools, signal);
        break;
      }
      cleanup();
      throw err;
    }
  }
  cleanup();
  return {
    fullContent: state.fullContent,
    toolCalls: sanitizeToolCalls(state.toolCalls),
    lastUsage: state.lastUsage,
    doneReason: state.doneReason,
    ...(state.provider !== initialProvider ? { finalProvider: state.provider } : {}),
    ...(state.tupleRotated ? { finalModel: state.model } : {}),
  };
}
