import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PreCompact',
  'SessionEnd',
] as const;

export type HookEvent = typeof HOOK_EVENTS[number];

/**
 * Returns absolute paths of every hook script the runtime would consider for
 * any event from the given cwd. Used at startup to surface "hook scripts on
 * disk that will fire this session" so the user is never surprised by a hook
 * inherited from a prior install or a sibling project.
 */
export function discoverAllHooks(cwd: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const event of HOOK_EVENTS) {
    for (const p of discoverHookScripts(event, cwd)) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * Returns absolute paths of hook scripts that should fire for this event.
 *
 * Resolution order (both run, global first, project second):
 *   1. ~/.factory/hooks/<event>.sh
 *   2. <cwd>/.factory/hooks/<event>.sh
 *
 * A path appears in the list only if the file exists. Errors stat-ing a
 * candidate (permissions, symlink loop, etc.) are swallowed — hooks are
 * opt-in and must never break the agent.
 */
export function discoverHookScripts(event: HookEvent, cwd: string): string[] {
  const candidates = [
    path.join(os.homedir(), '.factory', 'hooks', `${event}.sh`),
    path.join(cwd, '.factory', 'hooks', `${event}.sh`),
  ];
  const found: string[] = [];
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        found.push(candidate);
      }
    } catch {
      // missing or unreadable — skip silently
    }
  }
  return found;
}
