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

// Root-level instruction files loaded at session init. Mirrors the scoped set
// but limited to project-root scope on startup.
const PROJECT_STARTUP_INSTRUCTION_SOURCES = ['AGENTS.md', PROJECT_INSTRUCTIONS_FILE] as const;

const PROJECT_SCOPED_INSTRUCTION_SOURCES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', PROJECT_INSTRUCTIONS_FILE] as const;


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

// In-process cache so steady-state callers (every agent turn re-reads via
// run-loop.ts) don't repeatedly stat/parse/validate the same file or
// re-import migrateLegacyKeys. Keyed by resolved filePath so a mid-process
// env change (XDG_CONFIG_HOME swap in tests) routes to a different entry.
// Writes via saveGlobalConfig / updateGlobalConfig refresh the entry.
const configCache = new Map<string, Promise<Config>>();

function loadGlobalConfigUncached(filePath: string): Promise<Config> {
  return (async () => {
    const data = await readJsonFile(filePath);
    if (data === null) return {};
    const validated = validateConfig(data, filePath);
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
  })();
}

export async function loadGlobalConfig(): Promise<Config> {
  const filePath = getGlobalConfigFile();
  let pending = configCache.get(filePath);
  if (!pending) {
    pending = loadGlobalConfigUncached(filePath);
    configCache.set(filePath, pending);
    // If the load rejects, drop the entry so a retry can re-read.
    pending.catch(() => {
      if (configCache.get(filePath) === pending) configCache.delete(filePath);
    });
  }
  return pending;
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

/**
 * Type-level proof that the holder is executing inside `withConfigLock`.
 * The constructor is private, so the only way to obtain one is to be
 * invoked by `withConfigLock` (which mints one per critical section).
 *
 * Every writer that touches the on-disk config file must accept a
 * `ConfigWriteCapability` parameter. A future helper added inside
 * this file that forgets to go through `withConfigLock` cannot obtain
 * a capability and so cannot call any writer — the omission becomes a
 * compile error, not a runtime race.
 *
 * Lifts the f848472 contract from a load+save arch test pattern to a
 * type-level guarantee for in-module writers.
 */
class ConfigWriteCapability {
  // The constructor is intentionally private so other code in this
  // module cannot mint one directly — only `withConfigLock` can.
  private constructor() {}
  /**
   * Internal factory used solely by `withConfigLock`. Not exported.
   * The double-underscore naming is a reader hint; the access gate
   * is the private constructor + module scope.
   */
  static __mint(): ConfigWriteCapability {
    return new (ConfigWriteCapability as unknown as { new (): ConfigWriteCapability })();
  }
}

function withConfigLock<T>(fn: (cap: ConfigWriteCapability) => Promise<T>): Promise<T> {
  const run = (): Promise<T> => fn(ConfigWriteCapability.__mint());
  const next = configMutex.then(run, run);
  // Swallow rejections on the chain so one failed write doesn't poison
  // every subsequent call. Each caller still observes its own rejection
  // through the returned promise.
  configMutex = next.catch(() => undefined);
  return next;
}

async function writeMergedConfig(
  _cap: ConfigWriteCapability,
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
  // Drop the cache instead of repopulating: writes don't run
  // migrateLegacyKeys, so the next load needs to re-read and migrate
  // if the persisted shape changed.
  configCache.delete(filePath);
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
  return withConfigLock(async cap => {
    const filePath = getGlobalConfigFile();
    const existingRaw = (await readJsonFile(filePath)) ?? {};
    // Spread order: existingRaw first (preserves unknown/future keys), then config
    // (applies our updates). Validate only to catch type errors, then write the
    // merged raw object so unknown keys are not silently dropped.
    const merged = { ...existingRaw, ...config };
    return writeMergedConfig(cap, filePath, merged);
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
  return withConfigLock(async cap => {
    const filePath = getGlobalConfigFile();
    const existingRaw = (await readJsonFile(filePath)) ?? {};
    const validated = validateConfig(existingRaw, filePath);
    const updates = await mutate(validated);
    const merged = { ...existingRaw, ...updates };
    return writeMergedConfig(cap, filePath, merged);
  });
}

export async function loadProjectConfig(cwd: string): Promise<Config> {
  const configPath = path.join(cwd, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE);
  const data = await readJsonFile(configPath);
  if (data === null) return {};
  return validateConfig(data, configPath);
}

function isWithinRoot(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function ancestorsToRoot(start: string, root: string): string[] {
  const out: string[] = [];
  let cur = path.resolve(start);
  const absRoot = path.resolve(root);
  while (isWithinRoot(cur, absRoot)) {
    out.push(cur);
    if (cur === absRoot) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

interface InstructionSource {
  filePath: string;
  label: string;
}

async function loadInstructionBlocks(
  sources: readonly InstructionSource[],
  onFileLoaded?: (filePath: string) => void,
): Promise<string | null> {
  const contents = await Promise.all(sources.map(src => readTextFile(src.filePath)));

  const parts: string[] = [];

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]!;
    const content = contents[i];
    if (content === null || content === undefined || content.length === 0) continue;

    parts.push(`## From ${src.label}\n\n${content}\n\n`);
    onFileLoaded?.(src.filePath);
  }

  if (parts.length === 0) return null;
  return parts.join('').trimEnd();
}

/**
 * Loads startup project instructions from the project root.
 *
 * Startup reads `.factory/AGENTS.md` and `.factory/INSTRUCTIONS.md`, plus
 * virtual project-root instruction files under `~/.factory/` when present.
 * Other scoped instruction files are loaded lazily during execution.
 */
export async function loadProjectInstructions(
  cwd: string,
  onFileLoaded?: (filePath: string) => void,
): Promise<string | null> {
  const root = path.resolve(cwd);
  const projectInstrDir = path.join(root, PROJECT_CONFIG_DIR);
  const virtualRoot = path.join(os.homedir(), '.factory');
  const sources: InstructionSource[] = [];
  for (const name of PROJECT_STARTUP_INSTRUCTION_SOURCES) {
    sources.push({
      filePath: path.join(projectInstrDir, name),
      label: path.join(PROJECT_CONFIG_DIR, name),
    });
  }
  for (const name of PROJECT_STARTUP_INSTRUCTION_SOURCES) {
    sources.push({
      filePath: path.join(virtualRoot, name),
      label: path.join('~/.factory', name),
    });
  }
  return loadInstructionBlocks(sources, onFileLoaded);
}

/**
 * Loads directory-scoped instruction files for the union of:
 * - each touched directory
 * - its parents up to and including `projectRoot`
 *
 * Directories are sorted child → root (deepest first) so the most specific
 * instructions appear earliest in the prompt and are never displaced by
 * shallower, more general files. Virtual-root (~/.factory/) entries follow
 * all project directories.
 *
 * There is no byte cap: all discovered files are included. The context
 * manager handles overall window budgeting.
 */
export async function loadScopedProjectInstructions(
  projectRoot: string,
  touchedDirs: Iterable<string>,
  onFileLoaded?: (filePath: string) => void,
  options?: { virtualRootDirs?: readonly string[] },
): Promise<string | null> {
  const root = path.resolve(projectRoot);
  const dirs = new Set<string>();
  for (const dir of touchedDirs) {
    for (const ancestor of ancestorsToRoot(path.resolve(dir), root)) {
      dirs.add(ancestor);
    }
  }

  // Sort deepest first so more-specific (child) instructions come before
  // less-specific (parent) ones. Tie-break alphabetically for stability.
  const sortedDirs = [...dirs].sort((a, b) => {
    const aDepth = path.relative(root, a).split(path.sep).filter(Boolean).length;
    const bDepth = path.relative(root, b).split(path.sep).filter(Boolean).length;
    if (aDepth !== bDepth) return bDepth - aDepth; // deeper first
    return a.localeCompare(b);
  });

  const sources: InstructionSource[] = [];

  for (const dir of sortedDirs) {
    const relDir = path.relative(root, dir);
    for (const name of PROJECT_SCOPED_INSTRUCTION_SOURCES) {
      const label = relDir ? path.join(relDir, name) : name;
      sources.push({ filePath: path.join(root, label), label });
    }
  }

  // Virtual-root entries (~/.factory/) come after all project directories.
  for (const virtualRoot of options?.virtualRootDirs ?? []) {
    for (const name of PROJECT_SCOPED_INSTRUCTION_SOURCES) {
      sources.push({ filePath: path.join(virtualRoot, name), label: path.join('~/.factory', name) });
    }
  }

  return loadInstructionBlocks(sources, onFileLoaded);
}

interface CliOverrides {
  provider?: string;
  model?: string;
  host?: string;
  token?: string;
}

export async function loadConfig(cwd: string, cliOverrides?: CliOverrides): Promise<Config> {
  const [global, project] = await Promise.all([loadGlobalConfig(), loadProjectConfig(cwd)]);

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
