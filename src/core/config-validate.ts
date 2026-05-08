// Config-shape validation. Pure: no I/O, no side effects beyond a stderr
// warning for unknown top-level keys (warning-not-fail preserves
// downgrade compatibility — see top-level KNOWN_TOP_LEVEL_KEYS comment).
//
// Was a single 300-line function in config.ts under an
// `eslint-disable -- TODO(complexity): split per-section validators`
// waiver. Now broken out section by section so each piece is small
// enough to read at a glance and individually testable.

import type { Config } from './config-types.js';
import { EXPERIMENTAL_FLAG_KEYS } from './config-types.js';
import { HOOK_EVENTS } from './hooks/discovery.js';

// Top-level fields the current build understands. Unknown keys at this
// level are reported via a stderr warning (not a hard error): hard-reject
// would create a downgrade hazard — a newer factory adding a field would
// make all configs unloadable by older builds. Warning still surfaces
// typos like `permissons` (instead of `permissions`) loudly enough that
// users notice and fix them.
const STRING_TOP_LEVEL_KEYS = [
  'provider',
  'model',
  'host',
  'token',
  'huggingfaceToken',
  'anthropicToken',
  'copilotToken',
  'githubToken',
  'openrouterToken',
  'vercelToken',
  'opencodeZenToken',
  'googleAiStudioToken',
  'mistralToken',
  'codestralToken',
  'cerebrasToken',
  'groqToken',
  'cohereToken',
  'workersAiToken',
  'workersAiAccountId',
] as const;

const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set<string>([
  ...STRING_TOP_LEVEL_KEYS,
  'googleAiStudioAuthMode',
  'keys',
  'agent',
  'permissions',
  'security',
  'mcp',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateTopLevelStrings(obj: Record<string, unknown>, filePath: string): void {
  const unknown = Object.keys(obj).filter(k => !KNOWN_TOP_LEVEL_KEYS.has(k));
  if (unknown.length > 0) {
    process.stderr.write(
      `${filePath}: warning: unknown top-level field${unknown.length > 1 ? 's' : ''} ` +
        `${unknown.map(k => `"${k}"`).join(', ')} (ignored). ` +
        `Did you mean one of: ${[...KNOWN_TOP_LEVEL_KEYS].sort().join(', ')}?\n`,
    );
  }

  for (const key of STRING_TOP_LEVEL_KEYS) {
    if (obj[key] !== undefined && typeof obj[key] !== 'string') {
      throw new Error(`${filePath}: "${key}" must be a string`);
    }
  }
  if (
    obj.googleAiStudioAuthMode !== undefined &&
    obj.googleAiStudioAuthMode !== 'api-key' &&
    obj.googleAiStudioAuthMode !== 'oauth'
  ) {
    throw new Error(`${filePath}: "googleAiStudioAuthMode" must be "api-key" or "oauth"`);
  }
}

function validateRotationChain(chain: unknown, basePath: string, filePath: string): void {
  if (!Array.isArray(chain)) {
    throw new Error(`${filePath}: "${basePath}" must be an array`);
  }
  chain.forEach((entry, i) => {
    if (!isPlainObject(entry)) {
      throw new Error(`${filePath}: "${basePath}[${i}]" must be an object`);
    }
    if (typeof entry.provider !== 'string' || !entry.provider) {
      throw new Error(`${filePath}: "${basePath}[${i}].provider" must be a non-empty string`);
    }
    if (typeof entry.model !== 'string' || !entry.model) {
      throw new Error(`${filePath}: "${basePath}[${i}].model" must be a non-empty string`);
    }
  });
}

function validateAgentRotation(rot: unknown, filePath: string): void {
  if (!isPlainObject(rot)) {
    throw new Error(`${filePath}: "agent.rotation" must be an object`);
  }
  for (const flag of ['keys', 'models'] as const) {
    if (rot[flag] !== undefined && typeof rot[flag] !== 'boolean') {
      throw new Error(`${filePath}: "agent.rotation.${flag}" must be a boolean`);
    }
  }
  if (rot.default !== undefined) {
    validateRotationChain(rot.default, 'agent.rotation.default', filePath);
  }
  if (rot.overrides !== undefined) {
    if (!isPlainObject(rot.overrides)) {
      throw new Error(`${filePath}: "agent.rotation.overrides" must be an object`);
    }
    for (const [scope, chain] of Object.entries(rot.overrides)) {
      validateRotationChain(chain, `agent.rotation.overrides.${JSON.stringify(scope)}`, filePath);
    }
  }
}

function validateHookEntry(
  entry: unknown,
  event: string,
  i: number,
  filePath: string,
): void {
  if (!isPlainObject(entry)) {
    throw new Error(`${filePath}: "agent.hooks.${event}[${i}]" must be an object`);
  }
  if (typeof entry.command !== 'string' || !entry.command) {
    throw new Error(
      `${filePath}: "agent.hooks.${event}[${i}].command" must be a non-empty string`,
    );
  }
  if (entry.matcher !== undefined && typeof entry.matcher !== 'string') {
    throw new Error(`${filePath}: "agent.hooks.${event}[${i}].matcher" must be a string`);
  }
  if (
    entry.timeoutMs !== undefined &&
    (typeof entry.timeoutMs !== 'number' ||
      entry.timeoutMs <= 0 ||
      !Number.isFinite(entry.timeoutMs))
  ) {
    throw new Error(
      `${filePath}: "agent.hooks.${event}[${i}].timeoutMs" must be a positive number`,
    );
  }
}

function validateAgentHooks(hooks: unknown, filePath: string): void {
  if (!isPlainObject(hooks)) {
    throw new Error(`${filePath}: "agent.hooks" must be an object`);
  }
  // Soft-validate event keys: unknown events are skipped with a warning
  // rather than aborting startup. A typo like `PreTooluse` would otherwise
  // hard-fail factory; the warning surfaces it without locking the user
  // out of every other hook in the same file. resolveHooks() only reads
  // events from HOOK_EVENTS, so unknown keys are inert at runtime.
  for (const [event, entries] of Object.entries(hooks)) {
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
    entries.forEach((entry, i) => validateHookEntry(entry, event, i, filePath));
  }
}

function validateAgentExperimental(exp: unknown, filePath: string): void {
  if (!isPlainObject(exp)) {
    throw new Error(`${filePath}: "agent.experimental" must be an object`);
  }
  for (const key of Object.keys(exp)) {
    if (!EXPERIMENTAL_FLAG_KEYS.includes(key as (typeof EXPERIMENTAL_FLAG_KEYS)[number])) {
      throw new Error(
        `${filePath}: unknown experimental flag "agent.experimental.${key}". Known flags: ${EXPERIMENTAL_FLAG_KEYS.join(', ')}`,
      );
    }
    if (typeof exp[key] !== 'boolean') {
      throw new Error(`${filePath}: "agent.experimental.${key}" must be a boolean`);
    }
  }
}

function validateAgentSection(agent: unknown, filePath: string): void {
  if (!isPlainObject(agent)) {
    throw new Error(`${filePath}: "agent" must be an object`);
  }
  if (agent.compactionThreshold !== undefined) {
    if (
      typeof agent.compactionThreshold !== 'number' ||
      agent.compactionThreshold < 0 ||
      agent.compactionThreshold > 1
    ) {
      throw new Error(`${filePath}: "agent.compactionThreshold" must be a number between 0 and 1`);
    }
  }
  if (agent.recencyWindow !== undefined) {
    if (
      typeof agent.recencyWindow !== 'number' ||
      agent.recencyWindow < 0 ||
      !Number.isInteger(agent.recencyWindow)
    ) {
      throw new Error(`${filePath}: "agent.recencyWindow" must be a non-negative integer`);
    }
  }
  if (agent.turnTimeoutSec !== undefined) {
    if (
      typeof agent.turnTimeoutSec !== 'number' ||
      agent.turnTimeoutSec <= 0 ||
      !Number.isFinite(agent.turnTimeoutSec)
    ) {
      throw new Error(`${filePath}: "agent.turnTimeoutSec" must be a positive number`);
    }
  }
  if (agent.rotation !== undefined) validateAgentRotation(agent.rotation, filePath);
  if (agent.hooks !== undefined) validateAgentHooks(agent.hooks, filePath);
  if (agent.experimental !== undefined) validateAgentExperimental(agent.experimental, filePath);
}

function validateBashRule(rule: unknown, i: number, filePath: string): void {
  if (!isPlainObject(rule)) {
    throw new Error(`${filePath}: "permissions.bashRules[${i}]" must be an object`);
  }
  if (typeof rule.pattern !== 'string' || rule.pattern.length === 0) {
    throw new Error(
      `${filePath}: "permissions.bashRules[${i}].pattern" must be a non-empty string`,
    );
  }
  if (rule.decision !== 'allow' && rule.decision !== 'deny' && rule.decision !== 'prompt') {
    throw new Error(
      `${filePath}: "permissions.bashRules[${i}].decision" must be "allow" | "deny" | "prompt"`,
    );
  }
  if (rule.note !== undefined && typeof rule.note !== 'string') {
    throw new Error(`${filePath}: "permissions.bashRules[${i}].note" must be a string`);
  }
}

function validatePermissionsSection(perms: unknown, filePath: string): void {
  if (!isPlainObject(perms)) {
    throw new Error(`${filePath}: "permissions" must be an object`);
  }
  if (perms.allowAll !== undefined) {
    if (!Array.isArray(perms.allowAll) || !perms.allowAll.every(s => typeof s === 'string')) {
      throw new Error(`${filePath}: "permissions.allowAll" must be an array of strings`);
    }
  }
  if (perms.bashRules !== undefined) {
    if (!Array.isArray(perms.bashRules)) {
      throw new Error(`${filePath}: "permissions.bashRules" must be an array`);
    }
    perms.bashRules.forEach((r, i) => validateBashRule(r, i, filePath));
  }
}

function validateSecuritySection(sec: unknown, filePath: string): void {
  if (!isPlainObject(sec)) {
    throw new Error(`${filePath}: "security" must be an object`);
  }
  if (sec.bashEnv !== undefined) {
    if (!isPlainObject(sec.bashEnv)) {
      throw new Error(`${filePath}: "security.bashEnv" must be an object`);
    }
    const env = sec.bashEnv;
    for (const key of ['allow', 'allowPrefixes', 'deny', 'denyPrefixes'] as const) {
      if (env[key] !== undefined) {
        if (
          !Array.isArray(env[key]) ||
          !(env[key] as unknown[]).every(s => typeof s === 'string')
        ) {
          throw new Error(`${filePath}: "security.bashEnv.${key}" must be an array of strings`);
        }
      }
    }
  }
  if (sec.paths !== undefined) {
    if (!isPlainObject(sec.paths)) {
      throw new Error(`${filePath}: "security.paths" must be an object`);
    }
    if (sec.paths.deny !== undefined) {
      if (
        !Array.isArray(sec.paths.deny) ||
        !(sec.paths.deny as unknown[]).every(s => typeof s === 'string')
      ) {
        throw new Error(`${filePath}: "security.paths.deny" must be an array of strings`);
      }
    }
  }
}

function validateMcpSection(mcp: unknown, filePath: string): void {
  if (!isPlainObject(mcp)) {
    throw new Error(`${filePath}: "mcp" must be an object`);
  }
  if (mcp.servers !== undefined && !Array.isArray(mcp.servers)) {
    throw new Error(`${filePath}: "mcp.servers" must be an array`);
  }
}

function validateProviderKey(
  entry: unknown,
  provider: string,
  i: number,
  filePath: string,
): void {
  if (!isPlainObject(entry)) {
    throw new Error(`${filePath}: "keys.${provider}[${i}]" must be an object`);
  }
  if (typeof entry.id !== 'string' || !entry.id) {
    throw new Error(`${filePath}: "keys.${provider}[${i}].id" must be a non-empty string`);
  }
  if (typeof entry.token !== 'string' || !entry.token) {
    throw new Error(`${filePath}: "keys.${provider}[${i}].token" must be a non-empty string`);
  }
  if (typeof entry.createdAt !== 'string' || !entry.createdAt) {
    throw new Error(`${filePath}: "keys.${provider}[${i}].createdAt" must be a non-empty string`);
  }
  if (entry.label !== undefined && typeof entry.label !== 'string') {
    throw new Error(`${filePath}: "keys.${provider}[${i}].label" must be a string`);
  }
  if (entry.extras !== undefined) {
    if (!isPlainObject(entry.extras)) {
      throw new Error(`${filePath}: "keys.${provider}[${i}].extras" must be an object`);
    }
    for (const [k, v] of Object.entries(entry.extras)) {
      if (typeof v !== 'string') {
        throw new Error(`${filePath}: "keys.${provider}[${i}].extras.${k}" must be a string`);
      }
    }
  }
}

function validateKeysSection(keys: unknown, filePath: string): void {
  if (!isPlainObject(keys)) {
    throw new Error(`${filePath}: "keys" must be an object keyed by provider name`);
  }
  for (const [provider, list] of Object.entries(keys)) {
    if (!Array.isArray(list)) {
      throw new Error(`${filePath}: "keys.${provider}" must be an array`);
    }
    list.forEach((entry, i) => validateProviderKey(entry, provider, i, filePath));
  }
}

/**
 * Validates the structure of a parsed config blob and returns it typed as
 * Config. Throws on bad shape with a message that names the file and field
 * so users can fix it quickly. Unknown top-level fields trigger a stderr
 * warning (not a throw) to preserve forward-compatibility between
 * factory versions.
 */
export function validateConfig(data: unknown, filePath: string): Config {
  if (!isPlainObject(data)) {
    throw new Error(`${filePath}: top-level must be a JSON object`);
  }
  validateTopLevelStrings(data, filePath);
  if (data.agent !== undefined) validateAgentSection(data.agent, filePath);
  if (data.permissions !== undefined) validatePermissionsSection(data.permissions, filePath);
  if (data.security !== undefined) validateSecuritySection(data.security, filePath);
  if (data.mcp !== undefined) validateMcpSection(data.mcp, filePath);
  if (data.keys !== undefined) validateKeysSection(data.keys, filePath);
  return data as Config;
}
