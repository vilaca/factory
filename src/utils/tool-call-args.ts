/** Normalize provider-emitted tool-call arguments into a plain object.
 * Providers may return structured objects or JSON-stringified blobs. This helper
 * swallows malformed inputs and falls back to an empty object so callers can
 * safely read fields without defensive type checks everywhere.
 */
export function normalizeToolArguments(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Invalid JSON — fall through to empty object.
    }
  }
  return {};
}
