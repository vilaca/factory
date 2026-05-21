/**
 * Wire a lifecycle hook into a project config. The hook command `touch
 * <markerPath>` lets a test assert that the lifecycle event actually fired
 * by checking the filesystem afterward.
 */

import fs from 'fs';
import path from 'path';
import type { HooksConfig, HookEntry } from '../../src/core/config/types.js';
import { writeProjectConfig } from './writeConfig.js';

export type HookEvent = keyof HooksConfig;

export function markerHookCommand(markerPath: string): string {
  // `touch` is in every POSIX env we test on; double-quote to be safe with
  // path characters. The hook runs via `sh -c`.
  return `touch "${markerPath}"`;
}

export function writeHook(
  cwd: string,
  event: HookEvent,
  entry: HookEntry,
): void {
  const cfgPath = path.join(cwd, '.factory', 'config.json');
  let existing: { agent?: { hooks?: HooksConfig } } = {};
  if (fs.existsSync(cfgPath)) {
    existing = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  }
  const hooks = (existing.agent?.hooks ?? {}) as HooksConfig;
  const list = (hooks[event] ?? []) as HookEntry[];
  list.push(entry);
  hooks[event] = list;
  writeProjectConfig(cwd, {
    ...existing,
    agent: { ...(existing.agent ?? {}), hooks, experimental: { hooks: true } },
  });
}
