// First-run trust prompt for project-local hooks and MCP servers.
//
// Threat: a hostile project's `.factory/config.json` can declare hooks AND
// MCP servers. Both fire the moment you `cd` into the repo and run `factory`:
// SessionStart hooks auto-execute, and stdio MCP servers spawn arbitrary
// binaries via `child_process.spawn`. Even with env-scrub and
// forbidden-patterns, those processes inherit the user's filesystem access
// and can run any non-blocked command. Defense: prompt once per project
// before any project-local hook or MCP server runs; persist a fingerprint
// so subsequent runs skip the prompt; re-prompt when the fingerprint
// changes (the hook or MCP config was edited).
//
// Trust state lives in `~/.factory/trusted-projects.json`:
//   { "<absolute-project-dir>": { "fingerprint": "<sha256-hex>" } }
//
// The fingerprint covers only the project's hook block and MCP server list
// (not the whole config), so unrelated config edits don't void the trust
// decision. Projects with hooks-only (no MCP) keep the same fingerprint as
// before this change — existing trust entries stay valid.

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { HooksConfig } from '../config/types.js';
import type { McpServerConfig } from '../../mcp/types.js';
import { writeFileAtomic } from '../../utils/atomic-write.js';

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

export interface ProjectTrustables {
  hooks: HooksConfig | undefined;
  mcpServers: McpServerConfig[] | undefined;
}

/** Fingerprint the project's hook block plus its MCP server list. When the
 *  project has no MCP servers, this collapses to `fingerprintHooks(hooks)` so
 *  trust entries recorded before MCP-trust shipped remain valid. */
export function fingerprintProjectTrustables(t: ProjectTrustables): string {
  const hooks = t.hooks ?? {};
  const mcp = t.mcpServers ?? [];
  if (mcp.length === 0) {
    return fingerprintHooks(hooks);
  }
  const payload = { hooks, mcpServers: mcp };
  return crypto.createHash('sha256').update(canonicalize(payload)).digest('hex');
}

function canonicalize(value: unknown): string {
  // Mirror JSON.stringify's handling of undefined: it returns the raw
  // value (not the string "undefined") for top-level undefined, becomes
  // null inside arrays, and is omitted entirely from objects. Without
  // this, `JSON.stringify(undefined)` would leak the literal `undefined`
  // into our hash input — which then `+`-concatenates as the string
  // "undefined", letting `{a: undefined}` and `{a: "undefined"}` collide.
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter(k => obj[k] !== undefined)
    .sort();
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
  await writeFileAtomic(file, JSON.stringify(db, null, 2));
}

export async function isProjectTrusted(
  projectDir: string,
  trustables: ProjectTrustables,
): Promise<boolean> {
  const entry = (await readDb())[projectDir];
  if (!entry) return false;
  return entry.fingerprint === fingerprintProjectTrustables(trustables);
}

export async function recordTrust(
  projectDir: string,
  trustables: ProjectTrustables,
): Promise<void> {
  const db = await readDb();
  db[projectDir] = { fingerprint: fingerprintProjectTrustables(trustables) };
  await writeDb(db);
}
