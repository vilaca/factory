// Layered config merge. The runtime resolves config from three layers —
// global (~/.config/factory/config.json) → project (.factory/config.json)
// → CLI overrides — with later layers winning for scalar fields and
// merging additively for collections (bashRules, mcp.servers,
// rotation.overrides). Pulled out of config.ts so the merge rules can
// evolve without bloating the I/O orchestrator.

import type { Config } from './types.js';

function mergeStringArrays(a?: string[], b?: string[]): string[] | undefined {
  return a || b ? [...(a ?? []), ...(b ?? [])] : undefined;
}

function mergeAgent(prev: Config['agent'], next: NonNullable<Config['agent']>): Config['agent'] {
  const mergedExperimental =
    next.experimental || prev?.experimental
      ? { ...prev?.experimental, ...next.experimental }
      : undefined;
  const mergedRotation =
    next.rotation || prev?.rotation
      ? {
          ...prev?.rotation,
          ...next.rotation,
          // Override map merges shallowly per scope so a project config
          // can override only specific scopes from global without wiping
          // the rest.
          ...(next.rotation?.overrides || prev?.rotation?.overrides
            ? {
                overrides: {
                  ...prev?.rotation?.overrides,
                  ...next.rotation?.overrides,
                },
              }
            : {}),
        }
      : undefined;
  return {
    ...prev,
    ...next,
    ...(mergedExperimental ? { experimental: mergedExperimental } : {}),
    ...(mergedRotation ? { rotation: mergedRotation } : {}),
  };
}

function mergePermissions(
  prev: Config['permissions'],
  next: NonNullable<Config['permissions']>,
): Config['permissions'] {
  // bashRules are additive across config layers (global → project → CLI)
  // so a project can extend the user's global allow list without
  // having to repeat it.
  const mergedRules =
    prev?.bashRules || next.bashRules
      ? [...(prev?.bashRules ?? []), ...(next.bashRules ?? [])]
      : undefined;
  return {
    ...prev,
    ...next,
    ...(mergedRules ? { bashRules: mergedRules } : {}),
  };
}

function mergeSecurity(
  prev: Config['security'],
  next: NonNullable<Config['security']>,
): Config['security'] {
  const bashEnv =
    next.bashEnv || prev?.bashEnv
      ? {
          allow: mergeStringArrays(prev?.bashEnv?.allow, next.bashEnv?.allow),
          allowPrefixes: mergeStringArrays(
            prev?.bashEnv?.allowPrefixes,
            next.bashEnv?.allowPrefixes,
          ),
          deny: mergeStringArrays(prev?.bashEnv?.deny, next.bashEnv?.deny),
          denyPrefixes: mergeStringArrays(prev?.bashEnv?.denyPrefixes, next.bashEnv?.denyPrefixes),
        }
      : undefined;
  const paths =
    next.paths || prev?.paths
      ? {
          deny: mergeStringArrays(prev?.paths?.deny, next.paths?.deny),
        }
      : undefined;
  return {
    ...(bashEnv ? { bashEnv } : {}),
    ...(paths ? { paths } : {}),
  };
}

const SCALAR_KEYS = [
  'provider',
  'model',
  'host',
  'token',
  'copilotToken',
  'githubToken',
  'googleAiStudioToken',
  'googleAiStudioAuthMode',
  'workersAiAccountId',
] as const;
export function mergeConfigs(...configs: Config[]): Config {
  const result: Config = {};

  for (const config of configs) {
    for (const key of SCALAR_KEYS) {
      if (config[key] !== undefined) {
        // Last-write-wins for scalars. Cast to satisfy the union of value
        // types — TS can't see that the `key` narrows symmetrically
        // across both sides of the assignment.
        (result as Record<string, unknown>)[key] = config[key];
      }
    }
    if (config.keys !== undefined) {
      // keys are global-only state; project configs that set keys override
      // matching providers wholesale. Most users will only have keys at the
      // global layer, so this branch is a degenerate copy in practice.
      result.keys = { ...result.keys, ...config.keys };
    }
    if (config.agent) {
      result.agent = mergeAgent(result.agent, config.agent);
    }
    if (config.permissions) {
      result.permissions = mergePermissions(result.permissions, config.permissions);
    }
    if (config.security) {
      result.security = mergeSecurity(result.security, config.security);
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
