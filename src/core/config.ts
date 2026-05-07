import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { Config } from './config-types.js';
import { EXPERIMENTAL_FLAG_KEYS } from './config-types.js';
import { errorMessage } from '../utils/errors.js';
import { HOOK_EVENTS } from './hooks/discovery.js';
import { writeFileAtomic } from '../utils/atomic-write.js';

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

/**
 * Validates the structure of a parsed config blob and returns it typed as
 * Config. Throws on bad shape with a message that names the file and field
 * so users can fix it quickly. Unknown fields are tolerated for forward
 * compatibility.
 */
function validateConfig(data: unknown, filePath: string): Config {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${filePath}: top-level must be a JSON object`);
  }
  const obj = data as Record<string, unknown>;

  for (const key of ['provider', 'model', 'host', 'token', 'huggingfaceToken', 'anthropicToken', 'copilotToken', 'githubToken', 'openrouterToken', 'vercelToken', 'opencodeZenToken', 'googleAiStudioToken', 'mistralToken', 'codestralToken', 'cerebrasToken', 'groqToken', 'cohereToken', 'workersAiToken', 'workersAiAccountId'] as const) {
    if (obj[key] !== undefined && typeof obj[key] !== 'string') {
      throw new Error(`${filePath}: "${key}" must be a string`);
    }
  }
  if (obj.googleAiStudioAuthMode !== undefined &&
      obj.googleAiStudioAuthMode !== 'api-key' &&
      obj.googleAiStudioAuthMode !== 'oauth') {
    throw new Error(`${filePath}: "googleAiStudioAuthMode" must be "api-key" or "oauth"`);
  }

  if (obj.agent !== undefined) {
    if (obj.agent === null || typeof obj.agent !== 'object' || Array.isArray(obj.agent)) {
      throw new Error(`${filePath}: "agent" must be an object`);
    }
    const agent = obj.agent as Record<string, unknown>;
    if (agent.compactionThreshold !== undefined) {
      if (typeof agent.compactionThreshold !== 'number' ||
          agent.compactionThreshold < 0 || agent.compactionThreshold > 1) {
        throw new Error(`${filePath}: "agent.compactionThreshold" must be a number between 0 and 1`);
      }
    }
    if (agent.recencyWindow !== undefined) {
      if (typeof agent.recencyWindow !== 'number' || agent.recencyWindow < 0 ||
          !Number.isInteger(agent.recencyWindow)) {
        throw new Error(`${filePath}: "agent.recencyWindow" must be a non-negative integer`);
      }
    }
    if (agent.turnTimeoutSec !== undefined) {
      if (typeof agent.turnTimeoutSec !== 'number' || agent.turnTimeoutSec <= 0 ||
          !Number.isFinite(agent.turnTimeoutSec)) {
        throw new Error(`${filePath}: "agent.turnTimeoutSec" must be a positive number`);
      }
    }
    if (agent.rotation !== undefined) {
      if (agent.rotation === null || typeof agent.rotation !== 'object' || Array.isArray(agent.rotation)) {
        throw new Error(`${filePath}: "agent.rotation" must be an object`);
      }
      const rot = agent.rotation as Record<string, unknown>;
      for (const flag of ['keys', 'models'] as const) {
        if (rot[flag] !== undefined && typeof rot[flag] !== 'boolean') {
          throw new Error(`${filePath}: "agent.rotation.${flag}" must be a boolean`);
        }
      }
      const validateChain = (chain: unknown, path: string): void => {
        if (!Array.isArray(chain)) {
          throw new Error(`${filePath}: "${path}" must be an array`);
        }
        chain.forEach((entry, i) => {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error(`${filePath}: "${path}[${i}]" must be an object`);
          }
          const e = entry as Record<string, unknown>;
          if (typeof e.provider !== 'string' || !e.provider) {
            throw new Error(`${filePath}: "${path}[${i}].provider" must be a non-empty string`);
          }
          if (typeof e.model !== 'string' || !e.model) {
            throw new Error(`${filePath}: "${path}[${i}].model" must be a non-empty string`);
          }
        });
      };
      if (rot.default !== undefined) {
        validateChain(rot.default, 'agent.rotation.default');
      }
      if (rot.overrides !== undefined) {
        if (rot.overrides === null || typeof rot.overrides !== 'object' || Array.isArray(rot.overrides)) {
          throw new Error(`${filePath}: "agent.rotation.overrides" must be an object`);
        }
        for (const [scope, chain] of Object.entries(rot.overrides as Record<string, unknown>)) {
          validateChain(chain, `agent.rotation.overrides.${JSON.stringify(scope)}`);
        }
      }
    }

    if (agent.hooks !== undefined) {
      if (agent.hooks === null || typeof agent.hooks !== 'object' || Array.isArray(agent.hooks)) {
        throw new Error(`${filePath}: "agent.hooks" must be an object`);
      }
      // Soft-validate event keys: unknown events are skipped with a warning
      // rather than aborting startup. A typo like `PreTooluse` would otherwise
      // hard-fail factory; the warning surfaces it without locking the user
      // out of every other hook in the same file. resolveHooks() only reads
      // events from HOOK_EVENTS, so unknown keys are inert at runtime.
      for (const [event, entries] of Object.entries(agent.hooks as Record<string, unknown>)) {
        if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
          process.stderr.write(
            `${filePath}: warning: unknown hook event "agent.hooks.${event}" (skipped). ` +
            `Known events: ${HOOK_EVENTS.join(', ')}\n`,
          );
          continue;
        }
        if (!Array.isArray(entries)) {
          throw new Error(`${filePath}: "agent.hooks.${event}" must be an array`);
        }
        entries.forEach((entry, i) => {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error(`${filePath}: "agent.hooks.${event}[${i}]" must be an object`);
          }
          const e = entry as Record<string, unknown>;
          if (typeof e.command !== 'string' || !e.command) {
            throw new Error(`${filePath}: "agent.hooks.${event}[${i}].command" must be a non-empty string`);
          }
          if (e.matcher !== undefined && typeof e.matcher !== 'string') {
            throw new Error(`${filePath}: "agent.hooks.${event}[${i}].matcher" must be a string`);
          }
          if (e.timeoutMs !== undefined &&
              (typeof e.timeoutMs !== 'number' || e.timeoutMs <= 0 || !Number.isFinite(e.timeoutMs))) {
            throw new Error(`${filePath}: "agent.hooks.${event}[${i}].timeoutMs" must be a positive number`);
          }
        });
      }
    }

    if (agent.experimental !== undefined) {
      if (agent.experimental === null || typeof agent.experimental !== 'object' || Array.isArray(agent.experimental)) {
        throw new Error(`${filePath}: "agent.experimental" must be an object`);
      }
      const exp = agent.experimental as Record<string, unknown>;
      for (const key of Object.keys(exp)) {
        if (!EXPERIMENTAL_FLAG_KEYS.includes(key as typeof EXPERIMENTAL_FLAG_KEYS[number])) {
          throw new Error(
            `${filePath}: unknown experimental flag "agent.experimental.${key}". Known flags: ${EXPERIMENTAL_FLAG_KEYS.join(', ')}`,
          );
        }
        if (typeof exp[key] !== 'boolean') {
          throw new Error(`${filePath}: "agent.experimental.${key}" must be a boolean`);
        }
      }
    }
  }

  if (obj.permissions !== undefined) {
    if (obj.permissions === null || typeof obj.permissions !== 'object' || Array.isArray(obj.permissions)) {
      throw new Error(`${filePath}: "permissions" must be an object`);
    }
    const perms = obj.permissions as Record<string, unknown>;
    if (perms.allowAll !== undefined) {
      if (!Array.isArray(perms.allowAll) || !perms.allowAll.every(s => typeof s === 'string')) {
        throw new Error(`${filePath}: "permissions.allowAll" must be an array of strings`);
      }
    }
    if (perms.bashRules !== undefined) {
      if (!Array.isArray(perms.bashRules)) {
        throw new Error(`${filePath}: "permissions.bashRules" must be an array`);
      }
      perms.bashRules.forEach((r, i) => {
        if (r === null || typeof r !== 'object' || Array.isArray(r)) {
          throw new Error(`${filePath}: "permissions.bashRules[${i}]" must be an object`);
        }
        const rule = r as Record<string, unknown>;
        if (typeof rule.pattern !== 'string' || rule.pattern.length === 0) {
          throw new Error(`${filePath}: "permissions.bashRules[${i}].pattern" must be a non-empty string`);
        }
        if (rule.decision !== 'allow' && rule.decision !== 'deny' && rule.decision !== 'prompt') {
          throw new Error(`${filePath}: "permissions.bashRules[${i}].decision" must be "allow" | "deny" | "prompt"`);
        }
        if (rule.note !== undefined && typeof rule.note !== 'string') {
          throw new Error(`${filePath}: "permissions.bashRules[${i}].note" must be a string`);
        }
      });
    }
  }

  if (obj.security !== undefined) {
    if (obj.security === null || typeof obj.security !== 'object' || Array.isArray(obj.security)) {
      throw new Error(`${filePath}: "security" must be an object`);
    }
    const sec = obj.security as Record<string, unknown>;
    if (sec.bashEnv !== undefined) {
      if (sec.bashEnv === null || typeof sec.bashEnv !== 'object' || Array.isArray(sec.bashEnv)) {
        throw new Error(`${filePath}: "security.bashEnv" must be an object`);
      }
      const env = sec.bashEnv as Record<string, unknown>;
      for (const key of ['allow', 'allowPrefixes', 'deny', 'denyPrefixes'] as const) {
        if (env[key] !== undefined) {
          if (!Array.isArray(env[key]) || !(env[key] as unknown[]).every(s => typeof s === 'string')) {
            throw new Error(`${filePath}: "security.bashEnv.${key}" must be an array of strings`);
          }
        }
      }
    }
    if (sec.paths !== undefined) {
      if (sec.paths === null || typeof sec.paths !== 'object' || Array.isArray(sec.paths)) {
        throw new Error(`${filePath}: "security.paths" must be an object`);
      }
      const paths = sec.paths as Record<string, unknown>;
      if (paths.deny !== undefined) {
        if (!Array.isArray(paths.deny) || !(paths.deny as unknown[]).every(s => typeof s === 'string')) {
          throw new Error(`${filePath}: "security.paths.deny" must be an array of strings`);
        }
      }
    }
  }

  if (obj.mcp !== undefined) {
    if (obj.mcp === null || typeof obj.mcp !== 'object' || Array.isArray(obj.mcp)) {
      throw new Error(`${filePath}: "mcp" must be an object`);
    }
    const mcp = obj.mcp as Record<string, unknown>;
    if (mcp.servers !== undefined && !Array.isArray(mcp.servers)) {
      throw new Error(`${filePath}: "mcp.servers" must be an array`);
    }
  }

  if (obj.keys !== undefined) {
    if (obj.keys === null || typeof obj.keys !== 'object' || Array.isArray(obj.keys)) {
      throw new Error(`${filePath}: "keys" must be an object keyed by provider name`);
    }
    for (const [provider, list] of Object.entries(obj.keys as Record<string, unknown>)) {
      if (!Array.isArray(list)) {
        throw new Error(`${filePath}: "keys.${provider}" must be an array`);
      }
      list.forEach((entry, i) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new Error(`${filePath}: "keys.${provider}[${i}]" must be an object`);
        }
        const e = entry as Record<string, unknown>;
        if (typeof e.id !== 'string' || !e.id) {
          throw new Error(`${filePath}: "keys.${provider}[${i}].id" must be a non-empty string`);
        }
        if (typeof e.token !== 'string' || !e.token) {
          throw new Error(`${filePath}: "keys.${provider}[${i}].token" must be a non-empty string`);
        }
        if (typeof e.createdAt !== 'string' || !e.createdAt) {
          throw new Error(`${filePath}: "keys.${provider}[${i}].createdAt" must be a non-empty string`);
        }
        if (e.label !== undefined && typeof e.label !== 'string') {
          throw new Error(`${filePath}: "keys.${provider}[${i}].label" must be a string`);
        }
        if (e.extras !== undefined) {
          if (e.extras === null || typeof e.extras !== 'object' || Array.isArray(e.extras)) {
            throw new Error(`${filePath}: "keys.${provider}[${i}].extras" must be an object`);
          }
          for (const [k, v] of Object.entries(e.extras as Record<string, unknown>)) {
            if (typeof v !== 'string') {
              throw new Error(`${filePath}: "keys.${provider}[${i}].extras.${k}" must be a string`);
            }
          }
        }
      });
    }
  }

  return obj as Config;
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
  const { migrateLegacyKeys } = await import('./credentials.js');
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

async function writeMergedConfig(filePath: string, merged: Record<string, unknown>): Promise<Config> {
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
    const existingRaw = await readJsonFile(filePath) ?? {};
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
    const existingRaw = await readJsonFile(filePath) ?? {};
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

function mergeConfigs(...configs: Config[]): Config {
  const result: Config = {};

  for (const config of configs) {
    if (config.provider !== undefined) result.provider = config.provider;
    if (config.model !== undefined) result.model = config.model;
    if (config.host !== undefined) result.host = config.host;
    if (config.token !== undefined) result.token = config.token;
    if (config.huggingfaceToken !== undefined) result.huggingfaceToken = config.huggingfaceToken;
    if (config.anthropicToken !== undefined) result.anthropicToken = config.anthropicToken;
    if (config.copilotToken !== undefined) result.copilotToken = config.copilotToken;
    if (config.githubToken !== undefined) result.githubToken = config.githubToken;
    if (config.openrouterToken !== undefined) result.openrouterToken = config.openrouterToken;
    if (config.vercelToken !== undefined) result.vercelToken = config.vercelToken;
    if (config.opencodeZenToken !== undefined) result.opencodeZenToken = config.opencodeZenToken;
    if (config.googleAiStudioToken !== undefined) result.googleAiStudioToken = config.googleAiStudioToken;
    if (config.googleAiStudioAuthMode !== undefined) result.googleAiStudioAuthMode = config.googleAiStudioAuthMode;
    if (config.mistralToken !== undefined) result.mistralToken = config.mistralToken;
    if (config.codestralToken !== undefined) result.codestralToken = config.codestralToken;
    if (config.cerebrasToken !== undefined) result.cerebrasToken = config.cerebrasToken;
    if (config.groqToken !== undefined) result.groqToken = config.groqToken;
    if (config.cohereToken !== undefined) result.cohereToken = config.cohereToken;
    if (config.workersAiToken !== undefined) result.workersAiToken = config.workersAiToken;
    if (config.workersAiAccountId !== undefined) result.workersAiAccountId = config.workersAiAccountId;
    if (config.keys !== undefined) {
      // keys are global-only state; project configs that set keys override
      // matching providers wholesale. Most users will only have keys at the
      // global layer, so this branch is a degenerate copy in practice.
      result.keys = { ...result.keys, ...config.keys };
    }

    if (config.agent) {
      const mergedExperimental = config.agent.experimental || result.agent?.experimental
        ? { ...result.agent?.experimental, ...config.agent.experimental }
        : undefined;
      const mergedRotation = config.agent.rotation || result.agent?.rotation
        ? {
            ...result.agent?.rotation,
            ...config.agent.rotation,
            // Override map merges shallowly per scope so a project config
            // can override only specific scopes from global without wiping
            // the rest.
            ...(config.agent.rotation?.overrides || result.agent?.rotation?.overrides
              ? {
                  overrides: {
                    ...result.agent?.rotation?.overrides,
                    ...config.agent.rotation?.overrides,
                  },
                }
              : {}),
          }
        : undefined;
      result.agent = {
        ...result.agent,
        ...config.agent,
        ...(mergedExperimental ? { experimental: mergedExperimental } : {}),
        ...(mergedRotation ? { rotation: mergedRotation } : {}),
      };
    }
    if (config.permissions) {
      // bashRules are additive across config layers (global → project → CLI)
      // so a project can extend the user's global allow list without
      // having to repeat it.
      const mergedRules = (result.permissions?.bashRules || config.permissions.bashRules)
        ? [...(result.permissions?.bashRules ?? []), ...(config.permissions.bashRules ?? [])]
        : undefined;
      result.permissions = {
        ...result.permissions,
        ...config.permissions,
        ...(mergedRules ? { bashRules: mergedRules } : {}),
      };
    }
    if (config.security) {
      const merge = (a?: string[], b?: string[]): string[] | undefined =>
        a || b ? [...(a ?? []), ...(b ?? [])] : undefined;
      const bashEnv = config.security.bashEnv || result.security?.bashEnv ? {
        allow: merge(result.security?.bashEnv?.allow, config.security.bashEnv?.allow),
        allowPrefixes: merge(result.security?.bashEnv?.allowPrefixes, config.security.bashEnv?.allowPrefixes),
        deny: merge(result.security?.bashEnv?.deny, config.security.bashEnv?.deny),
        denyPrefixes: merge(result.security?.bashEnv?.denyPrefixes, config.security.bashEnv?.denyPrefixes),
      } : undefined;
      const paths = config.security.paths || result.security?.paths ? {
        deny: merge(result.security?.paths?.deny, config.security.paths?.deny),
      } : undefined;
      result.security = {
        ...(bashEnv ? { bashEnv } : {}),
        ...(paths ? { paths } : {}),
      };
    }
    if (config.mcp) {
      // MCP servers are additive
      const existing = result.mcp?.servers ?? [];
      const incoming = config.mcp.servers ?? [];
      result.mcp = { servers: [...existing, ...incoming] };
    }
  }

  return result;
}

export interface CliOverrides {
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
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
    'factory',
  );
}
