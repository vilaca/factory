import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { Config } from './types.js';
import { errorMessage } from '../../utils/errors.js';
import { writeFileAtomic } from '../../utils/atomic-write.js';
import { validateConfig } from './validate.js';
import { mergeConfigs } from './merge.js';

const PROJECT_CONFIG_DIR = '.factory';
const PROJECT_CONFIG_FILE = 'config.json';
const PROJECT_INSTRUCTIONS_FILE = 'INSTRUCTIONS.md';

// Repo-root files we'll pick up as project instructions, in priority order.
// `.factory/INSTRUCTIONS.md` is the canonical source; the others are
// cross-tool conventions (AGENTS.md, Claude Code, Cursor) that we read so
// users don't need to duplicate guidance.
const PROJECT_INSTRUCTION_SOURCES = [
  `${PROJECT_CONFIG_DIR}/${PROJECT_INSTRUCTIONS_FILE}`,
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
] as const;

// Cap on the total injected size to keep the system prompt bounded. Sources
// past the cap are dropped with a truncation note rather than streamed in.
const PROJECT_INSTRUCTIONS_MAX_BYTES = 16 * 1024;

function getGlobalConfigFile(): string {
  return path.join(getGlobalConfigDir(), 'config.json');
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    // Missing/unreadable file is not an error — config is optional.
    return null;
  }
  try {
    return JSON.parse(content);
  } catch (err: unknown) {
    throw new Error(`${filePath}: invalid JSON — ${errorMessage(err)}`);
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function loadGlobalConfig(): Promise<Config> {
  const filePath = getGlobalConfigFile();
  const data = await readJsonFile(filePath);
  if (data === null) return {};
  const validated = validateConfig(data, filePath);
  // Lift any legacy `<provider>Token` fields into the multi-key store on
  // first load under the new schema. Legacy fields stay in place so older
  // factory builds keep working if the user downgrades.
  // Lazy import to break the config ↔ credentials ↔ descriptors cycle.
  const { migrateLegacyKeys } = await import('../auth/credentials.js');
  const { changed, next } = migrateLegacyKeys(validated);
  if (changed) {
    try {
      await saveGlobalConfig({ keys: next.keys });
    } catch {
      // Best-effort: keep returning the migrated-in-memory config so the
      // current session works even if the disk write fails (read-only fs,
      // permission glitch). The next launch will retry the migration.
    }
    return next;
  }
  return validated;
}

// In-process serialization for config writes. Without this, two concurrent
// `addKey()` calls (e.g., user adds a key in one tab while another tab
// races a credential migration) interleave: each reads the same baseline,
// each writes its own merged result, and one write clobbers the other.
// The mutex covers both saveGlobalConfig and updateGlobalConfig so they
// can't interleave with each other either. Cross-process safety still
// requires file locking — out of scope here, but the same-process case is
// the dominant one (multiple TUI tabs, background promises).
let configMutex: Promise<unknown> = Promise.resolve();

function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = configMutex.then(fn, fn);
  // Swallow rejections on the chain so one failed write doesn't poison
  // every subsequent call. Each caller still observes its own rejection
  // through the returned promise.
  configMutex = next.catch(() => undefined);
  return next;
}

async function writeMergedConfig(
  filePath: string,
  merged: Record<string, unknown>,
): Promise<Config> {
  const validated = validateConfig(merged, filePath);
  const dir = getGlobalConfigDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(filePath, JSON.stringify(merged, null, 2) + '\n');
  if (process.platform !== 'win32') {
    // Repair legacy configs/dirs created by older versions with looser perms.
    await fs.chmod(filePath, 0o600).catch(() => {});
    await fs.chmod(dir, 0o700).catch(() => {});
  }
  return validated;
}

/**
 * Unconditional partial-update of the global config. Spreads `config` over
 * the existing on-disk config and writes atomically.
 *
 * IMPORTANT — read-modify-write callers must use {@link updateGlobalConfig}
 * instead. This function reads the on-disk baseline AFTER the caller has
 * already loaded their own copy, so a `loadGlobalConfig() → mutate →
 * saveGlobalConfig()` sequence loses concurrent writes that landed
 * in between. `updateGlobalConfig` does the read, the mutate, and the
 * write all under the same mutex.
 *
 * Use `saveGlobalConfig` only when the new value is independent of the
 * prior one (e.g., `{ provider: 'foo' }` to swap the active provider).
 * Use `updateGlobalConfig` for anything that appends, increments, or
 * otherwise depends on what's already there (keys, rotation chains,
 * experimental flags, …).
 */
export async function saveGlobalConfig(config: Partial<Config>): Promise<Config> {
  return withConfigLock(async () => {
    const filePath = getGlobalConfigFile();
    const existingRaw = (await readJsonFile(filePath)) ?? {};
    // Spread order: existingRaw first (preserves unknown/future keys), then config
    // (applies our updates). Validate only to catch type errors, then write the
    // merged raw object so unknown keys are not silently dropped.
    const merged = { ...existingRaw, ...config };
    return writeMergedConfig(filePath, merged);
  });
}

/**
 * Atomically read-modify-write the global config. The transformer receives
 * the latest validated on-disk config and returns a partial that's spread
 * over the on-disk raw the same way `saveGlobalConfig` handles its input.
 * The read, transform, and write all happen under the in-process mutex,
 * so concurrent updates serialise instead of racing on stale baselines.
 *
 * Use this (not load + save) whenever the new value depends on the prior
 * value — e.g., appending a credential to `keys[provider]`. Plain
 * `saveGlobalConfig` is fine for unconditional updates that don't depend
 * on what's already there.
 */
export async function updateGlobalConfig(
  mutate: (current: Config) => Partial<Config> | Promise<Partial<Config>>,
): Promise<Config> {
  return withConfigLock(async () => {
    const filePath = getGlobalConfigFile();
    const existingRaw = (await readJsonFile(filePath)) ?? {};
    const validated = validateConfig(existingRaw, filePath);
    const updates = await mutate(validated);
    const merged = { ...existingRaw, ...updates };
    return writeMergedConfig(filePath, merged);
  });
}

export async function loadProjectConfig(cwd: string): Promise<Config> {
  const configPath = path.join(cwd, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE);
  const data = await readJsonFile(configPath);
  if (data === null) return {};
  return validateConfig(data, configPath);
}

/**
 * Loads project instructions from the repo root. Reads
 * `.factory/INSTRUCTIONS.md` plus the cross-tool conventions
 * (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`) in priority order, concatenating
 * everything that exists with a `## From <relative-path>` header per source.
 *
 * Read errors are swallowed (treated as "not present") so a transient
 * permission glitch never crashes startup. Total size is capped at
 * ~16KB; sources that don't fit are dropped with a truncation note.
 */
export async function loadProjectInstructions(cwd: string): Promise<string | null> {
  const parts: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  for (const rel of PROJECT_INSTRUCTION_SOURCES) {
    const content = await readTextFile(path.join(cwd, rel));
    if (content === null || content.length === 0) continue;

    const block = `## From ${rel}\n\n${content}\n\n`;
    const blockBytes = Buffer.byteLength(block, 'utf-8');
    if (totalBytes + blockBytes > PROJECT_INSTRUCTIONS_MAX_BYTES) {
      truncated = true;
      break;
    }
    parts.push(block);
    totalBytes += blockBytes;
  }

  if (parts.length === 0) return null;

  let result = parts.join('').trimEnd();
  if (truncated) {
    result += `\n\n_(Project instructions truncated at ${PROJECT_INSTRUCTIONS_MAX_BYTES} bytes; remaining sources were skipped.)_`;
  }
  return result;
}

interface CliOverrides {
  provider?: string;
  model?: string;
  host?: string;
  token?: string;
}

export async function loadConfig(cwd: string, cliOverrides?: CliOverrides): Promise<Config> {
  const global = await loadGlobalConfig();
  const project = await loadProjectConfig(cwd);

  const cli: Config = {};
  if (cliOverrides?.provider) cli.provider = cliOverrides.provider;
  if (cliOverrides?.model) cli.model = cliOverrides.model;
  if (cliOverrides?.host) cli.host = cliOverrides.host;
  if (cliOverrides?.token) cli.token = cliOverrides.token;

  // Order: global (lowest) -> project -> CLI overrides (highest)
  return mergeConfigs(global, project, cli);
}

export function getGlobalConfigDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'factory');
}
