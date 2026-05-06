import type {
  ChatMessage,
  Provider,
  TokenUsage,
  ToolCallMessage,
  ToolDefinition,
} from '../../providers/types.js';
import type { AgentEvent, RotationOptions } from '../agent-types.js';
import { keyFingerprint, selectNextKey } from '../credentials.js';
import { classifyForRotation } from '../provider-errors.js';
import { RepeatDetector } from './repeat-detector.js';

function sanitizeToolCalls(
  toolCalls: Array<ToolCallMessage | null | undefined>,
): ToolCallMessage[] {
  return toolCalls.flatMap(toolCall => {
    if (!toolCall?.function || typeof toolCall.function.name !== 'string' || !toolCall.function.name) {
      return [];
    }

    const args = toolCall.function.arguments;
    return [{
      id: toolCall.id,
      function: {
        name: toolCall.function.name,
        arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
      },
    }];
  });
}

export interface ModelCallResult {
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
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  signal: AbortSignal | undefined,
  rotation?: RotationOptions,
): AsyncGenerator<AgentEvent, ModelCallResult> {
  let provider = initialProvider;
  // Per-call tried-set to prevent looping when every key 429s.
  const triedKeyIds = new Set<string>();
  if (rotation?.activeKeyId) triedKeyIds.add(rotation.activeKeyId);
  let activeKeyId = rotation?.activeKeyId;

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

  // Rotation loop: on a rate-limit/auth failure *before* any chunk has
  // streamed, try the next saved key. Streaming losses still surface
  // because retrying mid-stream would replay tokens the caller already
  // committed to scrollback.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let streamedAnything = false;
    try {
      for await (const chunk of provider.chat(model, messages, tools, { signal: internal.signal })) {
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
    } catch (err: any) {
      if (signal?.aborted || internal.signal.aborted || err.name === 'AbortError') {
        if (signal) signal.removeEventListener('abort', cascade);
        return { fullContent, toolCalls: sanitizeToolCalls(toolCalls), lastUsage, aborted: true, doneReason };
      }
      // Tier 1 rotation: only meaningful when no tokens have streamed yet
      // (otherwise we'd duplicate output on retry) and when we know which
      // key is currently active (otherwise we can't tell which keys we've
      // already tried).
      if (rotation && rotation.activeKeyId && !streamedAnything) {
        const reason = classifyForRotation(err);
        if (reason !== 'other') {
          if (rotation.failureLog && activeKeyId) {
            rotation.failureLog.set(activeKeyId, Date.now());
          }
          const next = selectNextKey(rotation.keys, triedKeyIds, {
            failureLog: rotation.failureLog,
          });
          if (next) {
            const fromKey = activeKeyId
              ? rotation.keys.find(k => k.id === activeKeyId)
              : undefined;
            yield {
              type: 'key-rotation',
              provider: provider.name,
              from: fromKey
                ? { keyId: fromKey.id, fingerprint: keyFingerprint(fromKey.token), ...(fromKey.label ? { label: fromKey.label } : {}) }
                : null,
              to: { keyId: next.id, fingerprint: keyFingerprint(next.token), ...(next.label ? { label: next.label } : {}) },
              reason,
            };
            triedKeyIds.add(next.id);
            activeKeyId = next.id;
            rotation.activeKeyId = next.id;
            rotation.onActiveKeyChange?.(next.id);
            provider = rotation.withKey(next);
            // Reset accumulators — the failed call yielded nothing usable.
            fullContent = '';
            toolCalls = [];
            lastUsage = undefined;
            doneReason = undefined;
            continue;
          }
          // Pool exhausted — surface a final notice and let the original
          // error propagate below.
          yield { type: 'key-rotation-exhausted', provider: provider.name, reason };
        }
      }
      // Existing isStreamish fallback: stream-only failures and transient
      // connection drops retry non-streamed once on the same provider.
      const msg = err?.message ?? '';
      const isStreamish = msg.includes('stream') || msg.includes('connection dropped') ||
        msg.includes('socket hang up') || msg.includes('fetch failed');
      if (isStreamish) {
        const response = await provider.chatNoStream(model, messages, tools, { signal });
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
  };
}
