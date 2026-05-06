// First-run trust prompt for project-local hooks.
//
// Threat: a hostile project's `.factory/config.json` declares hooks that fire
// the moment you `cd` into the repo and run `factory`. SessionStart auto-
// executes — even with env-scrub and forbidden-patterns the hook still has
// the user's read access to the filesystem and can run any non-blocked
// command. Defense: prompt once per project before any project-local hook
// runs; persist a fingerprint so subsequent runs skip the prompt; re-prompt
// when the fingerprint changes (the hook config was edited).
//
// Trust state lives in `~/.factory/trusted-projects.json`:
//   { "<absolute-project-dir>": { "fingerprint": "<sha256-hex>" } }
//
// The fingerprint covers ONLY the project's hook block (not the whole
// config), so unrelated config edits don't void the trust decision.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { HooksConfig } from '../config-types.js';

interface TrustEntry {
  fingerprint: string;
}

interface TrustDb {
  [projectDir: string]: TrustEntry;
}

function trustFile(): string {
  return path.join(os.homedir(), '.factory', 'trusted-projects.json');
}

/** Stable JSON fingerprint of the hook block. Sorted keys at every level so
 *  a no-op reorder of events doesn't void trust, but any value change does.
 *  Order of entries WITHIN an event array is preserved (it's semantic — hooks
 *  fire in declared order). */
export function fingerprintHooks(hooks: HooksConfig): string {
  return crypto.createHash('sha256').update(canonicalize(hooks)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const obj = value as Record<string, unknown>;
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

function readDb(): TrustDb {
  try {
    const raw = fs.readFileSync(trustFile(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as TrustDb;
    }
  } catch {
    // Missing / unreadable / malformed file → start fresh; never throw.
  }
  return {};
}

function writeDb(db: TrustDb): void {
  const dir = path.dirname(trustFile());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(trustFile(), JSON.stringify(db, null, 2), { mode: 0o600 });
}

export function isProjectTrusted(projectDir: string, hooks: HooksConfig): boolean {
  const entry = readDb()[projectDir];
  if (!entry) return false;
  return entry.fingerprint === fingerprintHooks(hooks);
}

export function recordTrust(projectDir: string, hooks: HooksConfig): void {
  const db = readDb();
  db[projectDir] = { fingerprint: fingerprintHooks(hooks) };
  writeDb(db);
}
