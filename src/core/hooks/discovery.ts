import type { HookEntry, HooksConfig } from '../config/types.js';
import { globMatch } from '../../utils/glob-match.js';

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'SessionEnd',
  'Stop',
  'StopFailure',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Resolve hook entries for `event` from the merged config, optionally
 * filtered by `matchValue` (typically the tool name for Pre/PostToolUse).
 *
 * Filter rules:
 *   - Entry has no `matcher` → always included.
 *   - Entry has a `matcher` and `matchValue` is provided → include when
 *     the matcher (shell glob) matches the value.
 *   - Entry has a `matcher` but `matchValue` is undefined → excluded
 *     (the event has no value to match against).
 */
export function resolveHooks(
  event: HookEvent,
  config: HooksConfig | undefined,
  matchValue?: string,
): HookEntry[] {
  const entries = config?.[event] ?? [];
  return entries.filter(entry => {
    if (!entry.matcher) return true;
    if (matchValue === undefined) return false;
    return globMatch(entry.matcher, matchValue);
  });
}

/**
 * Returns every hook command configured across every event. Used at startup
 * and by the `/hooks` slash command to surface what will fire this session
 * so the user is never surprised by an inherited config.
 */
export function listAllHooks(
  config: HooksConfig | undefined,
): { event: HookEvent; entry: HookEntry }[] {
  const out: { event: HookEvent; entry: HookEntry }[] = [];
  if (!config) return out;
  for (const event of HOOK_EVENTS) {
    for (const entry of config[event] ?? []) {
      out.push({ event, entry });
    }
  }
  return out;
}
