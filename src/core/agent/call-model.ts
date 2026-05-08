/* eslint-disable max-depth -- TODO(complexity): rotation/retry tier logic is deeply nested; flatten via early-return helpers. */
import type {
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
// eslint-disable-next-line max-statements, complexity, sonarjs/cognitive-complexity -- TODO(complexity): split rotation tiers into helpers.
export async function* callModel(
  initialProvider: Provider,
  initialModel: string,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  signal: AbortSignal | undefined,
  rotation?: RotationOptions,
): AsyncGenerator<AgentEvent, ModelCallResult> {
  let provider = initialProvider;
  let model = initialModel;
  // Per-call tried-set to prevent looping when every key 429s. Reset when
  // tier 2 advances to a new tuple — each tuple gets its own pool to walk.
  let triedKeyIds = new Set<string>();
  if (rotation?.activeKeyId) triedKeyIds.add(rotation.activeKeyId);
  let activeKeyId = rotation?.activeKeyId;
  // Hold the active key pool locally so a tier-2 tuple advance can swap it
  // in without mutating the caller's RotationOptions object. The previous
  // implementation wrote `rotation.keys = advance.keys`, which made the
  // function impure w.r.t. its inputs; nothing outside callModel reads
  // rotation.keys, so a local is a free upgrade.
  let activeKeys = rotation?.keys ?? [];
  // Tier-2 bookkeeping: track which (provider, model) tuples have already
  // been tried so we don't loop back to the original on chain advance.
  const triedTuples = new Set<string>([`${provider.name}:${model}`]);
  /** Did tier-2 ever advance away from the initial tuple? */
  let tupleRotated = false;

  let fullContent = '';
  let toolCalls: ToolCallMessage[] = [];
  let lastUsage: TokenUsage | undefined;
  let doneReason: string | undefined;

  // Combine the user's abort signal with an internal one so we can also
  // abort from inside this loop (e.g. when a runaway-repetition pattern is
  // detected). When the user aborts, we cascade to the internal one too.
  const internal = new AbortController();
  const cascade = (): void => internal.abort();
  if (signal) {
    if (signal.aborted) internal.abort();
    else signal.addEventListener('abort', cascade, { once: true });
  }
  const repeatDetector = new RepeatDetector();

  // Annotate cache boundaries once per call. The marked array shares the
  // same shape as `messages` — non-Anthropic providers ignore the
  // cacheBoundary hint and Anthropic's splitMessagesForAnthropic
  // translates it into cache_control blocks.
  const annotated = applyCacheBoundaries(messages);
  const callOpts = { signal: internal.signal, cacheTools: true };

  // Rotation loop: on a rate-limit/auth failure *before* any chunk has
  // streamed, try the next saved key. Streaming losses still surface
  // because retrying mid-stream would replay tokens the caller already
  // committed to scrollback.
  while (true) {
    let streamedAnything = false;
    try {
      for await (const chunk of provider.chat(model, annotated, tools, callOpts)) {
        if (signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        if (chunk.content) {
          yield { type: 'text-chunk', content: chunk.content };
          fullContent += chunk.content;
          streamedAnything = true;
          const repeat = repeatDetector.feed(chunk.content);
          if (repeat) {
            yield { type: 'repetition-detected', line: repeat.line, streak: repeat.streak };
            internal.abort();
          }
        }
        if (chunk.tool_calls) {
          toolCalls.push(...sanitizeToolCalls(chunk.tool_calls));
          streamedAnything = true;
        }
        if (chunk.usage) {
          lastUsage = chunk.usage;
        }
        if (chunk.doneReason) {
          doneReason = chunk.doneReason;
        }
      }
      break; // success
    } catch (err: unknown) {
      if (
        signal?.aborted ||
        internal.signal.aborted ||
        (isError(err) && err.name === 'AbortError')
      ) {
        if (signal) signal.removeEventListener('abort', cascade);
        return {
          fullContent,
          toolCalls: sanitizeToolCalls(toolCalls),
          lastUsage,
          aborted: true,
          doneReason,
        };
      }
      // Rotation: only meaningful when no tokens have streamed yet
      // (otherwise we'd duplicate output on retry).
      if (rotation && !streamedAnything) {
        const reason = classifyForRotation(err);
        if (reason !== 'other') {
          // ─── Tier 1: rotate keys for the current (provider, model) ──
          let keyRotated = false;
          if (rotation.activeKeyId && activeKeys.length > 0) {
            if (rotation.failureLog && activeKeyId) {
              rotation.failureLog.set(activeKeyId, Date.now());
            }
            const warmthLog = await rotation.getWarmthLog?.();
            const next = selectNextKey(activeKeys, triedKeyIds, {
              failureLog: rotation.failureLog,
              warmthLog,
            });
            if (next) {
              const fromKey = activeKeyId ? activeKeys.find(k => k.id === activeKeyId) : undefined;
              yield {
                type: 'key-rotation',
                provider: provider.name,
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
              triedKeyIds.add(next.id);
              activeKeyId = next.id;
              rotation.activeKeyId = next.id;
              rotation.onActiveKeyChange?.(next.id);
              provider = rotation.withKey(next);
              fullContent = '';
              toolCalls = [];
              lastUsage = undefined;
              doneReason = undefined;
              keyRotated = true;
            } else {
              yield { type: 'key-rotation-exhausted', provider: provider.name, reason };
            }
          }
          if (keyRotated) continue;

          // ─── Tier 2: advance to the next entry in the chain ────────
          if (
            rotation.modelsEnabled !== false &&
            rotation.chain &&
            rotation.chain.length > 0 &&
            rotation.loadKeysForProvider &&
            rotation.withTuple
          ) {
            const advance = await advanceTuple(rotation, triedTuples);
            if (advance) {
              yield {
                type: 'tuple-rotation',
                from: { provider: provider.name, model },
                to: { provider: advance.entry.provider, model: advance.entry.model },
                reason,
              };
              provider = advance.provider;
              model = advance.entry.model;
              activeKeyId = advance.firstKey.id;
              rotation.activeKeyId = advance.firstKey.id;
              rotation.onActiveKeyChange?.(advance.firstKey.id);
              rotation.onModelChange?.(advance.entry.model);
              // Reset tier-1 state for the new tuple.
              triedKeyIds = new Set<string>([advance.firstKey.id]);
              // Subsequent tier-1 attempts for this new tuple need to see
              // *its* keys, not the original tuple's. Swap them in via the
              // local `activeKeys` so the caller's RotationOptions stays
              // untouched.
              activeKeys = advance.keys;
              triedTuples.add(`${advance.entry.provider}:${advance.entry.model}`);
              tupleRotated = true;
              fullContent = '';
              toolCalls = [];
              lastUsage = undefined;
              doneReason = undefined;
              continue;
            }
            yield { type: 'tuple-rotation-exhausted', reason };
          }

          // ─── Last-chance prompt: ask the host (typically the UI) for
          //  a brand-new chain entry. The host decides whether to involve
          //  the user; we just await whatever entry it returns.
          if (rotation.promptForFallback && rotation.loadKeysForProvider && rotation.withTuple) {
            const promptedEntry = await rotation.promptForFallback({
              provider: provider.name,
              model,
              reason,
            });
            if (promptedEntry) {
              const promptedKey = `${promptedEntry.provider}:${promptedEntry.model}`;
              // Treat as a virtual one-shot chain advance. Same wiring as
              // tier 2: load the entry's keys, build a fresh provider,
              // reset the tier-1 tried-set, retry.
              if (!triedTuples.has(promptedKey)) {
                let promptedKeys: ProviderKey[] = [];
                try {
                  promptedKeys = await rotation.loadKeysForProvider(promptedEntry.provider);
                } catch {
                  // empty list — fall through to throw.
                }
                if (promptedKeys.length > 0) {
                  const firstKey = promptedKeys[0]!;
                  let nextProvider: Provider;
                  try {
                    nextProvider = rotation.withTuple(promptedEntry.provider, firstKey);
                  } catch {
                    // give up and let the original error propagate
                    if (signal) signal.removeEventListener('abort', cascade);
                    throw err;
                  }
                  yield {
                    type: 'tuple-rotation',
                    from: { provider: provider.name, model },
                    to: { provider: promptedEntry.provider, model: promptedEntry.model },
                    reason,
                  };
                  provider = nextProvider;
                  model = promptedEntry.model;
                  activeKeyId = firstKey.id;
                  rotation.activeKeyId = firstKey.id;
                  rotation.onActiveKeyChange?.(firstKey.id);
                  rotation.onModelChange?.(promptedEntry.model);
                  triedKeyIds = new Set<string>([firstKey.id]);
                  activeKeys = promptedKeys;
                  triedTuples.add(promptedKey);
                  tupleRotated = true;
                  fullContent = '';
                  toolCalls = [];
                  lastUsage = undefined;
                  doneReason = undefined;
                  continue;
                }
              }
            }
          }
        }
      }
      // Existing isStreamish fallback: stream-only failures and transient
      // connection drops retry non-streamed once on the same provider.
      const msg = errorMessage(err);
      const isStreamish =
        msg.includes('stream') ||
        msg.includes('connection dropped') ||
        msg.includes('socket hang up') ||
        msg.includes('fetch failed');
      if (isStreamish) {
        const response = await provider.chatNoStream(model, annotated, tools, {
          signal,
          cacheTools: true,
        });
        fullContent = response.content ?? '';
        toolCalls = sanitizeToolCalls(response.tool_calls ?? []);
        if (response.usage) {
          lastUsage = response.usage;
        }
        if (fullContent) {
          yield { type: 'text-chunk', content: fullContent };
        }
        break;
      }
      if (signal) signal.removeEventListener('abort', cascade);
      throw err;
    }
  }
  if (signal) signal.removeEventListener('abort', cascade);
  return {
    fullContent,
    toolCalls: sanitizeToolCalls(toolCalls),
    lastUsage,
    doneReason,
    ...(provider !== initialProvider ? { finalProvider: provider } : {}),
    ...(tupleRotated ? { finalModel: model } : {}),
  };
}
