import type { ProviderDescriptor, StartupProviderName } from '../../providers/registry.js';
import { descriptorByAlias, DESCRIPTORS } from '../../providers/registry.js';
import type {
  Config,
  ExperimentalFlags,
  RotationConfig,
  RotationEntry,
} from '../../core/config/types.js';
import type { CliArgs } from '../args.js';

/**
 * Decide whether the user can fast-path back into the previous session
 * (skipping the startup picker). Returns true only if the previously used
 * (provider, model) is still reachable in the current probe results.
 */
export function canResumeLastSession(
  last: { provider: string; model: string },
  probed: Map<StartupProviderName, string[] | null>,
): boolean {
  const descriptor: ProviderDescriptor | undefined =
    descriptorByAlias(last.provider) ??
    (DESCRIPTORS as Record<string, ProviderDescriptor | undefined>)[last.provider];
  if (!descriptor) return false;
  const models = probed.get(descriptor.name);
  if (!models) return false;
  return models.includes(last.model);
}

type RotationCliFlags = Pick<CliArgs, 'rotate' | 'noRotate' | 'noRotateKeys' | 'noRotateModels'>;

/**
 * Apply CLI rotation overrides to the existing rotation config and return
 * the merged result. Pure — no I/O. The caller is responsible for
 * persisting via `saveGlobalConfig` if `--save-rotate` is set.
 *
 * `parseChain` is injected so tests can stub it without coupling to the
 * real parser; production callers pass `parseRotationChain` from
 * `cli/startup/parse-rotation.ts`. May throw if `parseChain` rejects the spec.
 */
export function applyCliRotationOverrides(
  existing: RotationConfig | undefined,
  cliArgs: RotationCliFlags,
  parseChain: (spec: string) => RotationEntry[],
): RotationConfig {
  const next: RotationConfig = { ...(existing ?? {}) };
  if (cliArgs.rotate !== undefined) {
    next.default = parseChain(cliArgs.rotate);
  }
  if (cliArgs.noRotate) {
    next.keys = false;
    next.models = false;
  }
  if (cliArgs.noRotateKeys) next.keys = false;
  if (cliArgs.noRotateModels) next.models = false;
  return next;
}

type ExperimentalCliFlags = Pick<
  CliArgs,
  | 'bashDedup'
  | 'noBashDedup'
  | 'readCache'
  | 'noReadCache'
  | 'lineCountHint'
  | 'noLineCountHint'
  | 'subagents'
  | 'noSubagents'
  | 'skills'
  | 'noSkills'
  | 'hooks'
  | 'noHooks'
>;

/**
 * Merge defaults + config-file experimental flags + CLI flag overrides.
 * Precedence: CLI > config > built-in defaults.
 *
 * Pure; the only thing this does is shape an `ExperimentalFlags` object.
 */
export function buildExperimentalConfig(
  configExperimental: ExperimentalFlags | undefined,
  cliArgs: ExperimentalCliFlags,
): ExperimentalFlags {
  return {
    bashDedup: false,
    readCache: true,
    lineCountHint: true,
    subagents: true,
    skills: true,
    hooks: true,
    ...(configExperimental ?? {}),
    ...(cliArgs.bashDedup ? { bashDedup: true } : {}),
    ...(cliArgs.noBashDedup ? { bashDedup: false } : {}),
    ...(cliArgs.readCache ? { readCache: true } : {}),
    ...(cliArgs.noReadCache ? { readCache: false } : {}),
    ...(cliArgs.lineCountHint ? { lineCountHint: true } : {}),
    ...(cliArgs.noLineCountHint ? { lineCountHint: false } : {}),
    ...(cliArgs.subagents ? { subagents: true } : {}),
    ...(cliArgs.noSubagents ? { subagents: false } : {}),
    ...(cliArgs.skills ? { skills: true } : {}),
    ...(cliArgs.noSkills ? { skills: false } : {}),
    ...(cliArgs.hooks ? { hooks: true } : {}),
    ...(cliArgs.noHooks ? { hooks: false } : {}),
  };
}

/**
 * Three-way decision for which provider/model the session should start on:
 *  - `config`: an explicit `--provider <name>` (or `provider:` field) overrides
 *    everything else; model is decided downstream.
 *  - `last-session`: fast-path resuming the prior (provider, model, key) when
 *    `--pick` wasn't requested AND the prior selection still probes ok.
 *  - `picker`: open the interactive startup menu.
 *
 * Pure — no I/O. The picker invocation itself stays in the caller.
 */
export type StartupSource =
  | { kind: 'config'; provider: string }
  | { kind: 'last-session'; provider: string; model: string; keyId?: string }
  | { kind: 'picker' };

export function decideStartupSource(
  config: { provider?: string },
  cliArgs: Pick<CliArgs, 'pick'>,
  lastSession: { provider: string; model: string; keyId?: string } | null,
  probedModels: Map<StartupProviderName, string[] | null>,
): StartupSource {
  if (config.provider) {
    return { kind: 'config', provider: config.provider };
  }
  if (!cliArgs.pick && lastSession && canResumeLastSession(lastSession, probedModels)) {
    return {
      kind: 'last-session',
      provider: lastSession.provider,
      model: lastSession.model,
      ...(lastSession.keyId ? { keyId: lastSession.keyId } : {}),
    };
  }
  return { kind: 'picker' };
}

/**
 * Persist the merged rotation config to the global config file. Performs
 * a top-level shallow merge by reading `loadGlobal`, mutating only the
 * `agent.rotation` block, and writing back via `saveGlobal`. Both I/O
 * functions are injected so tests can stub them; production callers pass
 * `loadGlobalConfig` / `saveGlobalConfig` from `core/config/`.
 *
 * Throws if either I/O step throws — caller decides how to surface the
 * failure (main() prints to stderr and exits non-zero).
 */
export async function persistRotationConfig(
  rotation: RotationConfig,
  loadGlobal: () => Promise<Config>,
  saveGlobal: (patch: Partial<Config>) => Promise<unknown>,
): Promise<void> {
  const global = await loadGlobal();
  await saveGlobal({
    agent: { ...global.agent, rotation },
  });
}
