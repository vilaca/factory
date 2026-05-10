/**
 * Yield parsed JSON payloads from an OpenAI-style SSE response body.
 *
 * Strips the "data: " prefix, ignores the "[DONE]" sentinel, buffers across
 * chunk boundaries, and skips lines that don't parse as JSON rather than
 * throwing — matches the lenient behaviour every existing provider already
 * relies on.
 */
/** Dedicated error type for idle-timeout failures so call-site handlers can
 *  use `instanceof` instead of fragile message-string matching. Subclasses
 *  Error so existing catch-all paths (logging, telemetry) keep working. */
export class SseIdleTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`SSE idle timeout after ${timeoutMs}ms`);
    this.name = 'SseIdleTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export interface ParseSseStreamOptions {
  /**
   * Max time to wait for the next SSE bytes before rejecting. The timer is
   * reset after every successful `reader.read()` (so keepalive comments also
   * count as activity).
   */
  idleTimeoutMs?: number;
  /**
   * Called immediately before an idle-timeout error is thrown.
   * Useful for aborting the underlying HTTP request.
   */
  onIdleTimeout?: () => void;
}

export async function* parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options?: ParseSseStreamOptions,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await readWithIdleTimeout(reader, options);
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]' || !trimmed.startsWith('data: ')) continue;
      try {
        yield JSON.parse(trimmed.slice(6));
      } catch {
        // Provider injected something the JSON parser can't handle — skip it.
      }
    }
  }
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options?: ParseSseStreamOptions,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const timeoutMs = options?.idleTimeoutMs;
  if (!timeoutMs || timeoutMs <= 0) {
    return await reader.read();
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          options?.onIdleTimeout?.();
          reject(new SseIdleTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
