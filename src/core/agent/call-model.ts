import type {
  ChatChunk,
  ChatMessage,
  Provider,
  TokenUsage,
  ToolCallMessage,
  ToolDefinition,
} from '../../providers/types.js';
import type { AgentEvent, RotationOptions } from '../agent-types.js';
import type { ProviderKey } from '../config-types.js';
import { keyFingerprint, selectNextKey } from '../credentials.js';
import { classifyForRotation } from '../provider-errors.js';
import { RepeatDetector } from './repeat-detector.js';
import { applyCacheBoundaries } from './cache-boundaries.js';
import { errorMessage, isError } from '../../utils/errors.js';

type RotationReason = 'rate-limit' | 'auth';

/**
 * Mutable bundle of state that rotates between provider/model/key swaps.
 * Carrying it as one object keeps the rotation helpers callable without
 * juggling six out-params; the helpers reset accumulators on a successful
 * swap so the retry loop reads as if it were a fresh attempt.
 */
interface RotationState {
  provider: Provider;
  model: string;
  activeKeyId: string | undefined;
  activeKeys: ProviderKey[];
  triedKeyIds: Set<string>;
  triedTuples: Set<string>;
  tupleRotated: boolean;
  fullContent: string;
  toolCalls: ToolCallMessage[];
  lastUsage: TokenUsage | undefined;
  doneReason: string | undefined;
  /** Set true on the first chunk that lands. Read by the catch handler to
   *  decide whether rotation is meaningful (rotating mid-stream would
   *  duplicate tokens already committed to the caller's scrollback). */
  streamedAnything: boolean;
}

interface TierResult {
  /** True when state was advanced and the caller should retry the chat call. */
  rotated: boolean;
  /** Events to yield to the agent loop in order. */
  events: AgentEvent[];
  /** Set when the helper decides the original error must propagate (e.g.
   *  withTuple threw). The caller rethrows verbatim. */
  rethrow?: unknown;
}

function resetAccumulators(state: RotationState): void {
  state.fullContent = '';
  state.toolCalls = [];
  state.lastUsage = undefined;
  state.doneReason = undefined;
}

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

interface RotationOutcome {
  /** True when state advanced and the caller should retry the chat. */
  rotated: boolean;
  /** Set when the caller should rethrow the original error verbatim. */
  rethrow?: unknown;
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

/**
 * Walk tier-1 → tier-2 → prompted-fallback in order, yielding the events
 * each tier emits. Stops at the first tier that successfully advances state;
 * returns rotated=false when every tier exhausts. Caller decides whether to
 * retry (on rotated=true) or fall through (on rotated=false).
 */
async function* handleRotationFailure(
  state: RotationState,
  rotation: RotationOptions,
  err: unknown,
): AsyncGenerator<AgentEvent, RotationOutcome> {
  const reason = classifyForRotation(err);
  if (reason === 'other') return { rotated: false };

  const tier1 = await tryRotateKey(state, rotation, reason);
  for (const event of tier1.events) yield event;
  if (tier1.rotated) return { rotated: true };

  const tier2 = await tryRotateTuple(state, rotation, reason);
  for (const event of tier2.events) yield event;
  if (tier2.rotated) return { rotated: true };

  const fallback = await tryPromptedFallback(state, rotation, reason, err);
  for (const event of fallback.events) yield event;
  if (fallback.rotated) return { rotated: true };
  if (fallback.rethrow !== undefined) return { rotated: false, rethrow: fallback.rethrow };

  return { rotated: false };
}

/**
 * Walk the rotation chain looking for the next entry that hasn't been tried
 * yet AND whose provider has at least one saved key. Skips entries with
 * unknown providers (caller's `loadKeysForProvider` returns empty) and
 * already-tried tuples. Returns null when the chain is exhausted.
 */
async function advanceTuple(
  rotation: RotationOptions,
  tried: ReadonlySet<string>,
): Promise<{
  entry: { provider: string; model: string };
  provider: Provider;
  keys: ProviderKey[];
  firstKey: ProviderKey;
} | null> {
  if (!rotation.chain || !rotation.loadKeysForProvider || !rotation.withTuple) return null;
  for (const entry of rotation.chain) {
    const tupleKey = `${entry.provider}:${entry.model}`;
    if (tried.has(tupleKey)) continue;
    let keys: ProviderKey[];
    try {
      keys = await rotation.loadKeysForProvider(entry.provider);
    } catch {
      continue;
    }
    if (keys.length === 0) continue;
    const firstKey = keys[0]!;
    let nextProvider: Provider;
    try {
      nextProvider = rotation.withTuple(entry.provider, firstKey);
    } catch {
      continue;
    }
    return { entry, provider: nextProvider, keys, firstKey };
  }
  return null;
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

/**
 * Tier 1: rotate to the next saved key for the current (provider, model).
 * Stamps a failure for the outgoing key, picks the next available, swaps the
 * provider via `rotation.withKey`, and resets accumulators so the retry loop
 * starts clean.
 */
async function tryRotateKey(
  state: RotationState,
  rotation: RotationOptions,
  reason: RotationReason,
): Promise<TierResult> {
  if (!rotation.activeKeyId || state.activeKeys.length === 0) {
    return { rotated: false, events: [] };
  }
  if (rotation.failureLog && state.activeKeyId) {
    rotation.failureLog.set(state.activeKeyId, Date.now());
  }
  const warmthLog = await rotation.getWarmthLog?.();
  const next = selectNextKey(state.activeKeys, state.triedKeyIds, {
    failureLog: rotation.failureLog,
    warmthLog,
  });
  if (!next) {
    return {
      rotated: false,
      events: [{ type: 'key-rotation-exhausted', provider: state.provider.name, reason }],
    };
  }
  const fromKey = state.activeKeyId
    ? state.activeKeys.find(k => k.id === state.activeKeyId)
    : undefined;
  const event: AgentEvent = {
    type: 'key-rotation',
    provider: state.provider.name,
    from: fromKey
      ? {
          keyId: fromKey.id,
          fingerprint: keyFingerprint(fromKey.token),
          ...(fromKey.label ? { label: fromKey.label } : {}),
        }
      : null,
    to: {
      keyId: next.id,
      fingerprint: keyFingerprint(next.token),
      ...(next.label ? { label: next.label } : {}),
    },
    reason,
  };
  state.triedKeyIds.add(next.id);
  state.activeKeyId = next.id;
  rotation.activeKeyId = next.id;
  rotation.onActiveKeyChange?.(next.id);
  state.provider = rotation.withKey(next);
  resetAccumulators(state);
  return { rotated: true, events: [event] };
}

/**
 * Tier 2: advance to the next entry in the rotation chain, swapping the
 * (provider, model) tuple. Resets the tier-1 tried-set and active-keys for
 * the new tuple — each tuple has its own pool to walk.
 */
async function tryRotateTuple(
  state: RotationState,
  rotation: RotationOptions,
  reason: RotationReason,
): Promise<TierResult> {
  if (
    rotation.modelsEnabled === false ||
    !rotation.chain ||
    rotation.chain.length === 0 ||
    !rotation.loadKeysForProvider ||
    !rotation.withTuple
  ) {
    return { rotated: false, events: [] };
  }
  const advance = await advanceTuple(rotation, state.triedTuples);
  if (!advance) {
    return { rotated: false, events: [{ type: 'tuple-rotation-exhausted', reason }] };
  }
  const event: AgentEvent = {
    type: 'tuple-rotation',
    from: { provider: state.provider.name, model: state.model },
    to: { provider: advance.entry.provider, model: advance.entry.model },
    reason,
  };
  state.provider = advance.provider;
  state.model = advance.entry.model;
  state.activeKeyId = advance.firstKey.id;
  rotation.activeKeyId = advance.firstKey.id;
  rotation.onActiveKeyChange?.(advance.firstKey.id);
  rotation.onModelChange?.(advance.entry.model);
  state.triedKeyIds = new Set<string>([advance.firstKey.id]);
  state.activeKeys = advance.keys;
  state.triedTuples.add(`${advance.entry.provider}:${advance.entry.model}`);
  state.tupleRotated = true;
  resetAccumulators(state);
  return { rotated: true, events: [event] };
}

/**
 * Last-chance fallback: ask the host for a brand-new chain entry. Treats the
 * host's reply as a virtual tier-2 advance. Returns rethrow=err when the
 * prompt yields a tuple but constructing the provider throws — the original
 * error is more useful than a generic "fallback failed".
 */
async function tryPromptedFallback(
  state: RotationState,
  rotation: RotationOptions,
  reason: RotationReason,
  err: unknown,
): Promise<TierResult> {
  if (!rotation.promptForFallback || !rotation.loadKeysForProvider || !rotation.withTuple) {
    return { rotated: false, events: [] };
  }
  const promptedEntry = await rotation.promptForFallback({
    provider: state.provider.name,
    model: state.model,
    reason,
  });
  if (!promptedEntry) return { rotated: false, events: [] };
  const promptedKey = `${promptedEntry.provider}:${promptedEntry.model}`;
  if (state.triedTuples.has(promptedKey)) return { rotated: false, events: [] };

  let promptedKeys: ProviderKey[] = [];
  try {
    promptedKeys = await rotation.loadKeysForProvider(promptedEntry.provider);
  } catch {
    // empty list — fall through to the no-keys exit.
  }
  if (promptedKeys.length === 0) return { rotated: false, events: [] };

  const firstKey = promptedKeys[0]!;
  let nextProvider: Provider;
  try {
    nextProvider = rotation.withTuple(promptedEntry.provider, firstKey);
  } catch {
    return { rotated: false, events: [], rethrow: err };
  }

  const event: AgentEvent = {
    type: 'tuple-rotation',
    from: { provider: state.provider.name, model: state.model },
    to: { provider: promptedEntry.provider, model: promptedEntry.model },
    reason,
  };
  state.provider = nextProvider;
  state.model = promptedEntry.model;
  state.activeKeyId = firstKey.id;
  rotation.activeKeyId = firstKey.id;
  rotation.onActiveKeyChange?.(firstKey.id);
  rotation.onModelChange?.(promptedEntry.model);
  state.triedKeyIds = new Set<string>([firstKey.id]);
  state.activeKeys = promptedKeys;
  state.triedTuples.add(promptedKey);
  state.tupleRotated = true;
  resetAccumulators(state);
  return { rotated: true, events: [event] };
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

  const isAbortError = (err: unknown): boolean =>
    Boolean(signal?.aborted) ||
    internal.signal.aborted ||
    (isError(err) && err.name === 'AbortError');

  const isStreamish = (err: unknown): boolean => {
    const msg = errorMessage(err);
    return (
      msg.includes('stream') ||
      msg.includes('connection dropped') ||
      msg.includes('socket hang up') ||
      msg.includes('fetch failed')
    );
  };

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
      if (isAbortError(err)) {
        cleanup();
        return {
          fullContent: state.fullContent,
          toolCalls: sanitizeToolCalls(state.toolCalls),
          lastUsage: state.lastUsage,
          aborted: true,
          doneReason: state.doneReason,
        };
      }
      if (rotation && !state.streamedAnything) {
        const outcome = yield* handleRotationFailure(state, rotation, err);
        if (outcome.rotated) continue;
        if (outcome.rethrow !== undefined) {
          cleanup();
          throw outcome.rethrow;
        }
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
