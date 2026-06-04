import type { RotationEntry } from '../../core/config/types.js';
import { parseRotationEntry } from '../../core/config/rotation-parse.js';

export { parseRotationEntry };

/**
 * Parses a comma-separated `--rotate` arg string into a RotationEntry list.
 * Skips empty entries silently (so a trailing comma is fine). Throws on the
 * first malformed entry — surfaced as an explicit error so the user knows
 * which token went wrong rather than getting a silently truncated chain.
 */
export function parseRotationChain(spec: string): RotationEntry[] {
  const out: RotationEntry[] = [];
  for (const part of spec.split(',')) {
    if (!part.trim()) continue;
    const entry = parseRotationEntry(part);
    if (!entry) {
      throw new Error(`Invalid rotation entry "${part.trim()}". Expected "<provider>:<model>".`);
    }
    out.push(entry);
  }
  return out;
}
