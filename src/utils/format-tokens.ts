/** Compact token-count rendering used by every provider's model-picker
 * detail string (e.g. 128_000 → "128k", 1_000_000 → "1M"). Lives in
 * utils so non-provider modules (UI, stats) can format counts without
 * the modularity guard flagging a provider import. */
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
