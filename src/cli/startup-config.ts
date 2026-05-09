import type { ProviderDescriptor, StartupProviderName } from '../providers/descriptors.js';
import { descriptorByAlias, DESCRIPTORS } from '../providers/descriptors.js';
import type {
  ExperimentalFlags,
  RotationConfig,
  RotationEntry,
} from '../core/config/types.js';
import type { CliArgs } from './args.js';

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

type RotationCliFlags = Pick<
  CliArgs,
  'rotate' | 'noRotate' | 'noRotateKeys' | 'noRotateModels'
>;

/**
 * Apply CLI rotation overrides to the existing rotation config and return
 * the merged result. Pure — no I/O. The caller is responsible for
 * persisting via `saveGlobalConfig` if `--save-rotate` is set.
 *
 * `parseChain` is injected so tests can stub it without coupling to the
 * real parser; production callers pass `parseRotationChain` from
 * `cli/parse-rotation.ts`. May throw if `parseChain` rejects the spec.
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
