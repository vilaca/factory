import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { Config } from './config-types.js';
import { EXPERIMENTAL_FLAG_KEYS } from './config-types.js';

const PROJECT_CONFIG_DIR = '.factory';
const PROJECT_CONFIG_FILE = 'config.json';
const PROJECT_INSTRUCTIONS_FILE = 'INSTRUCTIONS.md';

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
  } catch (err: any) {
    throw new Error(`${filePath}: invalid JSON — ${err.message}`);
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

  for (const key of ['provider', 'model', 'host', 'token', 'huggingfaceToken', 'copilotToken', 'githubToken', 'openrouterToken', 'vercelToken', 'opencodeZenToken', 'googleAiStudioToken', 'mistralToken', 'codestralToken', 'cerebrasToken', 'groqToken', 'cohereToken', 'workersAiToken', 'workersAiAccountId'] as const) {
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
    if (agent.maxTurns !== undefined) {
      if (typeof agent.maxTurns !== 'number' || agent.maxTurns < 1 || !Number.isFinite(agent.maxTurns)) {
        throw new Error(`${filePath}: "agent.maxTurns" must be a number >= 1`);
      }
    }
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

  return obj as Config;
}

export async function loadGlobalConfig(): Promise<Config> {
  const filePath = getGlobalConfigFile();
  const data = await readJsonFile(filePath);
  if (data === null) return {};
  return validateConfig(data, filePath);
}

export async function saveGlobalConfig(config: Partial<Config>): Promise<Config> {
  const filePath = getGlobalConfigFile();
  const existingRaw = await readJsonFile(filePath) ?? {};
  // Spread order: existingRaw first (preserves unknown/future keys), then config
  // (applies our updates). Validate only to catch type errors, then write the
  // merged raw object so unknown keys are not silently dropped.
  const merged = { ...existingRaw, ...config };
  const validated = validateConfig(merged, filePath);
  await fs.mkdir(getGlobalConfigDir(), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  return validated;
}

export async function loadProjectConfig(cwd: string): Promise<Config> {
  const configPath = path.join(cwd, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE);
  const data = await readJsonFile(configPath);
  if (data === null) return {};
  return validateConfig(data, configPath);
}

export async function loadProjectInstructions(cwd: string): Promise<string | null> {
  const instructionsPath = path.join(cwd, PROJECT_CONFIG_DIR, PROJECT_INSTRUCTIONS_FILE);
  return readTextFile(instructionsPath);
}

export function mergeConfigs(...configs: Config[]): Config {
  const result: Config = {};

  for (const config of configs) {
    if (config.provider !== undefined) result.provider = config.provider;
    if (config.model !== undefined) result.model = config.model;
    if (config.host !== undefined) result.host = config.host;
    if (config.token !== undefined) result.token = config.token;
    if (config.huggingfaceToken !== undefined) result.huggingfaceToken = config.huggingfaceToken;
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

    if (config.agent) {
      const mergedExperimental = config.agent.experimental || result.agent?.experimental
        ? { ...result.agent?.experimental, ...config.agent.experimental }
        : undefined;
      result.agent = {
        ...result.agent,
        ...config.agent,
        ...(mergedExperimental ? { experimental: mergedExperimental } : {}),
      };
    }
    if (config.permissions) {
      result.permissions = { ...result.permissions, ...config.permissions };
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
