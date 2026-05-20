/** Strip trailing slashes from a base URL so callers can append paths
 * without worrying about double slashes. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Standard `Authorization: Bearer <token>` header object. */
export function bearerAuth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** Parse a tool-call `arguments` string from a provider's wire format.
 * Most providers send JSON, but a malformed payload should not crash the
 * stream — fall back to a `{ _raw: <string> }` envelope so the agent layer
 * can surface the original text to the corrector. */
export function parseToolArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

export { formatTokenCount } from '../utils/format-tokens.js';
