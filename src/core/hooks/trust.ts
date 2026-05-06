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

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto, { randomBytes } from 'crypto';
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

async function readDb(): Promise<TrustDb> {
  let raw: string;
  try {
    raw = await fs.readFile(trustFile(), 'utf-8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as TrustDb;
    }
  } catch {
    // Malformed file → start fresh; never throw.
  }
  return {};
}

async function writeDb(db: TrustDb): Promise<void> {
  const file = trustFile();
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Atomic write: write to a unique temp file (mode 0o600 from creation) and
  // rename onto the target. A crash mid-write leaves either the old DB intact
  // or the new one — never a half-written file.
  const tmp = path.join(dir, `trusted-projects.json.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const data = JSON.stringify(db, null, 2);
  try {
    await fs.writeFile(tmp, data, { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => { /* tmp may not exist if writeFile failed */ });
    throw err;
  }
}

export async function isProjectTrusted(projectDir: string, hooks: HooksConfig): Promise<boolean> {
  const entry = (await readDb())[projectDir];
  if (!entry) return false;
  return entry.fingerprint === fingerprintHooks(hooks);
}

export async function recordTrust(projectDir: string, hooks: HooksConfig): Promise<void> {
  const db = await readDb();
  db[projectDir] = { fingerprint: fingerprintHooks(hooks) };
  await writeDb(db);
}
