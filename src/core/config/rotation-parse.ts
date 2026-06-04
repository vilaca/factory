import type { RotationEntry } from './types.js';

/**
 * Parses a `<provider>:<model>` string into a RotationEntry. Returns null on
 * malformed input (no colon, empty parts) so callers can decide whether to
 * warn or hard-error. Whitespace around `:` is tolerated.
 *
 * Note: the model part is allowed to contain colons (some providers use
 * `prefix:variant` model ids) so we split on the *first* colon only.
 */
export function parseRotationEntry(spec: string): RotationEntry | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;
  const idx = trimmed.indexOf(':');
  if (idx <= 0) return null;
  const provider = trimmed.slice(0, idx).trim();
  const model = trimmed.slice(idx + 1).trim();
  if (!provider || !model) return null;
  return { provider, model };
}
