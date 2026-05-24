import type { StartupProviderName } from '../../providers/registry.js';
import type { Config } from '../../core/config/types.js';
import { getRecentSessions } from '../../core/session/session-log.js';
import { dbg } from '../../utils/debug.js';
import type { CliArgs } from '../args.js';
import type { StartupCredentials } from '../auth/index.js';
import { buildPickerOptions, findDefaultSelection } from '../picker.js';
import { selectStartupSession } from './menu.js';
import { decideStartupSource } from './config.js';
import type { ModelSelection } from '../../core/selection/types.js';

/** Result of provider resolution. The `resume*` field names retain the
 *  startup-time semantics ("resume from this model/key from prior
 *  session"); structurally each maps to ModelSelection. The
 *  fields are kept positional rather than wrapping a ModelSelection
 *  because the call site spreads them as positional args downstream. */
export interface ProviderSelection {
  providerName: string;
  resumeModel: string | null;
  resumeKeyId?: string;
}

/**
 * Decide which provider to launch on (config / last-session fast-path /
 * interactive picker), invoking the picker when needed.
 *
 * `lastSession` is the canonical ModelSelection record — threading it
 * through this signature (rather than re-declaring a parallel DTO with
 * keyId optional) is what 550f093 fixed. New cross-cutting fields on
 * ModelSelection flow through here for free.
 */
export async function resolveProvider(
  config: Config,
  cliArgs: CliArgs,
  lastSession: ModelSelection | null,
  credentials: Map<StartupProviderName, StartupCredentials>,
  probedModels: Map<StartupProviderName, string[] | null>,
): Promise<ProviderSelection> {
  const source = decideStartupSource(config, cliArgs, lastSession, probedModels);
  if (source.kind === 'config') {
    return { providerName: source.provider, resumeModel: null };
  }
  if (source.kind === 'last-session') {
    dbg(
      `resuming last session: ${source.provider}/${source.model}${source.keyId ? ` (key=${source.keyId})` : ''}`,
    );
    return {
      providerName: source.provider,
      resumeModel: source.model,
      ...(source.keyId ? { resumeKeyId: source.keyId } : {}),
    };
  }
  const recentSessions = await getRecentSessions(10).catch(() => []);
  const startupOptions = buildPickerOptions(probedModels);
  const defaultFromLast = await findDefaultSelection(
    lastSession,
    probedModels,
    config,
    credentials,
  );
  const fallbackDefault = startupOptions[0]
    ? { provider: startupOptions[0].descriptor.name }
    : { provider: 'copilot' as StartupProviderName };
  dbg(`opening picker (${recentSessions.length} recent, ${startupOptions.length} providers)`);
  const selection = await selectStartupSession(
    recentSessions,
    startupOptions,
    defaultFromLast ?? fallbackDefault,
  );
  dbg(
    `picker returned provider=${selection.provider} model=${selection.model ?? '<none>'}${selection.keyId ? ` keyId=${selection.keyId}` : ''}`,
  );
  return {
    providerName: selection.provider,
    resumeModel: selection.model ?? null,
    ...(selection.keyId ? { resumeKeyId: selection.keyId } : {}),
  };
}
