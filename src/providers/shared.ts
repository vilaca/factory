/** Strip trailing slashes from a base URL so callers can append paths
 * without worrying about double slashes. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Standard `Authorization: Bearer <token>` header object. */
export function bearerAuth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** Compact token-count rendering used by every provider's model-picker
 * detail string (e.g. 128_000 → "128k", 1_000_000 → "1M"). */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions.toFixed(millions % 1 === 0 ? 0 : 1).replace(/\.0$/, '')}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands.toFixed(thousands % 1 === 0 ? 0 : 1).replace(/\.0$/, '')}k`;
  }
  return String(value);
}
