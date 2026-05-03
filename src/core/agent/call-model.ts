import type {
  ChatMessage,
  Provider,
  TokenUsage,
  ToolCallMessage,
  ToolDefinition,
} from '../../providers/types.js';
import type { AgentEvent } from '../agent-types.js';
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
  provider: Provider,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  signal: AbortSignal | undefined,
): AsyncGenerator<AgentEvent, ModelCallResult> {
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
        const repeat = repeatDetector.feed(chunk.content);
        if (repeat) {
          yield { type: 'repetition-detected', line: repeat.line, streak: repeat.streak };
          internal.abort();
          // Continue to the catch block via the next iteration's AbortError.
        }
      }
      if (chunk.tool_calls) {
        toolCalls.push(...sanitizeToolCalls(chunk.tool_calls));
      }
      if (chunk.usage) {
        lastUsage = chunk.usage;
      }
      if (chunk.doneReason) {
        doneReason = chunk.doneReason;
      }
    }
  } catch (err: any) {
    if (signal?.aborted || internal.signal.aborted || err.name === 'AbortError') {
      // Don't throw — return what we got so the caller can preserve any
      // partial content (e.g. half-finished ASCII art the user wants kept).
      // This covers both user aborts and internal aborts (e.g. repetition).
        return { fullContent, toolCalls: sanitizeToolCalls(toolCalls), lastUsage, aborted: true, doneReason };
    }
    // Fall back to non-streaming for stream-only failures and for transient
    // connection drops that may resolve on a second attempt (e.g. Ollama
    // reloading the model after an idle timeout). Identified loosely so we
    // don't have to enumerate every transport phrase.
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
    } else {
      throw err;
    }
  } finally {
    if (signal) signal.removeEventListener('abort', cascade);
  }

  return { fullContent, toolCalls: sanitizeToolCalls(toolCalls), lastUsage, doneReason };
}
