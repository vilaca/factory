/**
 * Yield parsed JSON payloads from an OpenAI-style SSE response body.
 *
 * Strips the "data: " prefix, ignores the "[DONE]" sentinel, buffers across
 * chunk boundaries, and skips lines that don't parse as JSON rather than
 * throwing — matches the lenient behaviour every existing provider already
 * relies on.
 */
export async function* parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
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
