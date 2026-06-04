import type { SlashHandler } from './types.js';
import { SLASH_COMMANDS } from './spec.js';

/** Dispatch map derived from `SLASH_COMMANDS`. Flattens `name` +
 *  `aliases` so a single handler can be reached under any of its
 *  registered forms. Built once at module load — no per-call cost. */
export const HANDLERS: Record<string, SlashHandler> = Object.fromEntries(
  SLASH_COMMANDS.flatMap(spec => [spec.name, ...(spec.aliases ?? [])].map(n => [n, spec.handler] as const)),
);
