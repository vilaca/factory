import chalk from 'chalk';
import type { Provider } from '../../providers/types.js';
import type { ProviderDescriptor, StartupProviderName } from '../../providers/descriptors.js';
import { DESCRIPTORS, descriptorByAlias } from '../../providers/descriptors.js';
import { createProvider } from '../../providers/registry.js';
import type { Config, HookEntry } from '../../core/config/types.js';
import type { McpManager } from '../../mcp/client.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { validateModelToolSupport } from '../../core/auth/model-validation.js';
import { appendProviderLog, getRecentSessions } from '../../core/session/session-log.js';
import { renderError } from '../../ui/renderer.js';
import { getGitBranch, isGitDirty } from '../../utils/git.js';
import { errorMessage } from '../../utils/errors.js';
import { dbg } from '../../utils/debug.js';
import { withBoundedTimeout } from '../../utils/timeout.js';
import type { CliArgs } from '../args.js';
import {
  ensureAuth,
  saveCredentialsAfterModelDiscovery,
  type AuthResult,
  type StartupCredentials,
} from '../auth/index.js';
import { buildPickerOptions, findDefaultSelection } from '../picker.js';
import { selectModelInk, selectStartupSession } from './menu.js';
import { parseRotationChain } from '../parse-rotation.js';
import { applyCliRotationOverrides, decideStartupSource, persistRotationConfig } from './config.js';

/**
 * Apply CLI rotation overrides to `config.agent.rotation` and (when
 * `--save-rotate` is set) persist the merged result to the global config.
 * Mutates config in place. Calls `process.exit(1)` on parse / persist
 * failure.
 */
export async function applyRotationPhase(config: Config, cliArgs: CliArgs): Promise<void> {
  if (
    cliArgs.rotate === undefined &&
    !cliArgs.saveRotate &&
    !cliArgs.noRotate &&
    !cliArgs.noRotateKeys &&
    !cliArgs.noRotateModels
  ) {
    return;
  }
  let next;
  try {
    next = applyCliRotationOverrides(config.agent?.rotation, cliArgs, parseRotationChain);
  } catch (err: unknown) {
    console.log(renderError(errorMessage(err)));
    process.exit(1);
  }
  config.agent = { ...config.agent, rotation: next };
  if (cliArgs.saveRotate) {
    try {
      const { loadGlobalConfig, saveGlobalConfig } = await import('../../core/config/index.js');
      await persistRotationConfig(next, loadGlobalConfig, saveGlobalConfig);
    } catch (err: unknown) {
      console.log(renderError(`Failed to save rotation config: ${errorMessage(err)}`));
      process.exit(1);
    }
  }
}

interface ProviderSelection {
  providerName: string;
  resumeModel: string | null;
  resumeKeyId?: string;
}

/**
 * Decide which provider to launch on (config / last-session fast-path /
 * interactive picker), invoking the picker when needed.
 */
export async function resolveProvider(
  config: Config,
  cliArgs: CliArgs,
  lastSession: { provider: string; model: string; keyId?: string } | null,
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
  dbg(`picker returned provider=${selection.provider} model=${selection.model ?? '<none>'}`);
  return { providerName: selection.provider, resumeModel: selection.model ?? null };
}

interface ConnectedProvider {
  provider: Provider;
  descriptor?: ProviderDescriptor;
  availableModels: string[] | null;
  activeKeyId?: string;
}

/**
 * Run the auth flow for the selected provider, build the Provider, list
 * models, and persist credentials when the auth flow asked us to. Calls
 * `process.exit(1)` on failure with a provider-specific error message.
 */
export async function authenticateAndConnect(
  providerName: string,
  config: Config,
  cliArgs: CliArgs,
  resumeKeyId: string | undefined,
  probedModels: Map<StartupProviderName, string[] | null>,
): Promise<ConnectedProvider> {
  const descriptor =
    descriptorByAlias(providerName) ??
    (DESCRIPTORS as Record<string, ProviderDescriptor | undefined>)[providerName];
  let availableModels: string[] | null = descriptor
    ? (probedModels.get(descriptor.name) ?? null)
    : null;
  let activeKeyId: string | undefined;
  let provider: Provider;
  try {
    dbg(
      `ensureAuth flow=${descriptor?.authFlow ?? 'no-descriptor'}${resumeKeyId ? ` keyId=${resumeKeyId}` : ''}`,
    );
    const auth: AuthResult = descriptor
      ? await ensureAuth(descriptor, config, cliArgs.token, resumeKeyId)
      : { shouldSave: false };
    dbg(`ensureAuth ok shouldSave=${auth.shouldSave}`);

    provider = createProvider(providerName, {
      host: config.host,
      token: auth.token,
      githubToken: auth.githubToken,
      googleAiStudioAuthMode: auth.authMode,
      accountId: auth.accountId,
    });
    dbg(`createProvider ok`);

    if (!availableModels || provider.getDisplayModelName || provider.getModelPickerInfo) {
      dbg(`listModels (probe ${availableModels ? 'present but re-listing' : 'missing'})`);
      availableModels = await provider.listModels();
    }
    dbg(`availableModels.length=${availableModels?.length ?? 0}`);

    activeKeyId = auth.keyId;
    if (descriptor) {
      const savedKeyId = await saveCredentialsAfterModelDiscovery(
        descriptor,
        auth,
        availableModels.length > 0,
      );
      // First-time-save path: addKey just minted a fresh id. Adopt it so
      // the first turn's stats land under the right key.
      if (savedKeyId) activeKeyId = savedKeyId;
    }
  } catch (err: unknown) {
    const msg = errorMessage(err);
    dbg(`startup error: ${msg}`);
    appendProviderLog({
      provider: providerName,
      category: 'startup',
      action: 'startup-error',
      outcome: 'error',
      detail: msg,
    });
    if (providerName === 'ollama') {
      console.log(renderError('Cannot connect to Ollama. Is it running? (ollama serve)'));
    } else if (providerName === 'llamacpp') {
      console.log(
        renderError(
          'Cannot connect to llama.cpp. Is the server running? (llama-server -m <model>)',
        ),
      );
    } else {
      console.log(renderError(msg));
    }
    process.exit(1);
  }
  return {
    provider,
    ...(descriptor ? { descriptor } : {}),
    availableModels,
    ...(activeKeyId ? { activeKeyId } : {}),
  };
}

interface ValidatedModel {
  model: string;
  useTextToolFallback: boolean;
  validationWarning?: string;
  validationMode: 'native' | 'fallback' | 'unreachable';
}

/**
 * Pick the model (config / resume / picker) and validate the provider's
 * tool-support claim against a real probe call. Calls `process.exit(1)`
 * if validation reports the provider is unreachable.
 */
export async function selectAndValidateModel(
  provider: Provider,
  providerName: string,
  config: Config,
  resumeModel: string | null,
  lastSession: { provider: string; model: string } | null,
  availableModels: string[] | null,
): Promise<ValidatedModel> {
  let model: string;
  if (config.model) {
    model = config.model;
    dbg(`model from config: ${model}`);
  } else if (resumeModel && availableModels?.includes(resumeModel)) {
    model = resumeModel;
    dbg(`resuming model from picker: ${model}`);
  } else {
    const lastModelForProvider =
      lastSession?.provider === providerName ? lastSession.model : null;
    dbg(`opening selectModel (default=${lastModelForProvider ?? '<none>'})`);
    model = await selectModelInk(availableModels ?? [], lastModelForProvider, provider, providerName);
    dbg(`selectModel returned: ${model}`);
  }

  dbg(`validating model capabilities for ${model}`);
  const validation = await validateModelToolSupport(provider, model);
  dbg(`validation mode=${validation.mode}`);
  if (validation.mode === 'unreachable') {
    console.log(renderError(validation.reason));
    process.exit(1);
  }
  const useTextToolFallback = validation.mode === 'fallback';
  return {
    model,
    useTextToolFallback,
    ...(useTextToolFallback ? { validationWarning: validation.warning } : {}),
    validationMode: validation.mode,
  };
}

interface ShutdownHandlerOptions {
  /** Returns the live MCP manager (or undefined if MCP isn't configured).
   *  Callable so the closure picks up changes after install — e.g. when
   *  MCP setup completes after the handler is wired. */
  getMcpManager: () => McpManager | undefined;
  budgetMs: number;
}

/**
 * Install SIGINT and SIGTERM handlers that run a bounded cleanup race —
 * disconnects MCP, flushes per-key stats, and forces exit if cleanup
 * exceeds the wall-clock budget. Used to prevent a hung MCP `close()`
 * from blocking process termination.
 */
export function installShutdownHandlers(opts: ShutdownHandlerOptions): void {
  const cleanup = async (): Promise<void> => {
    const pending: string[] = [];
    const mcpManager = opts.getMcpManager();
    if (mcpManager) {
      const { pending: stuck } = await mcpManager.disconnect().catch(() => ({ pending: [] }));
      for (const name of stuck) pending.push(`mcp:${name}`);
    }
    const flushDone = (async () => {
      const { flushKeyStats } = await import('../../core/session/key-stats.js');
      await flushKeyStats();
    })().catch(() => {
      pending.push('key-stats');
    });
    await flushDone;
    if (pending.length > 0) {
      process.stderr.write(`shutdown: ${pending.join(', ')} did not finish in time\n`);
    }
  };
  const boundedCleanup = (): Promise<void> =>
    withBoundedTimeout(cleanup, opts.budgetMs, () => {
      process.stderr.write(`shutdown: cleanup exceeded ${opts.budgetMs}ms, forcing exit\n`);
    }).then(() => undefined);
  process.on('SIGINT', () => {
    void boundedCleanup().finally(() => process.exit(130));
  });
  process.on('SIGTERM', () => {
    void boundedCleanup().finally(() => process.exit(0));
  });
}

interface GitState {
  gitBranch?: string;
  gitDirty: boolean | null;
}

/**
 * Resolve git branch + dirty status in parallel, surfacing soft warnings
 * (yellow ⚠ chalk text) on either failure rather than aborting the
 * launch. A repo without git or with permission issues still launches.
 */
export async function gatherGitState(cwd: string): Promise<GitState> {
  let gitBranch: string | undefined;
  let gitDirty: boolean | null = null;
  const [branchRes, dirtyRes] = await Promise.allSettled([getGitBranch(cwd), isGitDirty(cwd)]);
  if (branchRes.status === 'fulfilled') {
    gitBranch = branchRes.value;
  } else {
    const msg =
      branchRes.reason instanceof Error ? branchRes.reason.message : String(branchRes.reason);
    console.log(chalk.yellow(`  ⚠ Could not read git branch: ${msg}`));
  }
  if (dirtyRes.status === 'fulfilled') {
    gitDirty = dirtyRes.value;
  } else {
    const msg =
      dirtyRes.reason instanceof Error ? dirtyRes.reason.message : String(dirtyRes.reason);
    console.log(chalk.yellow(`  ⚠ Could not check git dirty state: ${msg}`));
  }
  return { ...(gitBranch !== undefined ? { gitBranch } : {}), gitDirty };
}

/**
 * First-run trust check for project-local hooks. The merged config
 * already folds project hooks into `config.agent.hooks`, but we need the
 * project-only slice (without user-level entries) to fingerprint and
 * prompt against — user hooks are implicitly trusted (the user wrote
 * them in their own home dir).
 *
 * On reject (or non-TTY default 'n'), strips project hook entries from
 * the merged config so they don't fire for this session.
 */
export async function handleProjectHookTrust(config: Config, cwd: string): Promise<void> {
  const { loadProjectConfig } = await import('../../core/config/index.js');
  const projectOnly = await loadProjectConfig(cwd);
  const projectHooks = projectOnly.agent?.hooks;
  if (!projectHooks || Object.keys(projectHooks).length === 0) return;

  const { isProjectTrusted, recordTrust } = await import('../../core/hooks/trust.js');
  if (await isProjectTrusted(cwd, projectHooks)) return;

  const { promptText } = await import('../prompts.js');
  console.log('');
  console.log(chalk.yellow(' ⚠ This project declares hooks in .factory/config.json:'));
  for (const [event, entries] of Object.entries(projectHooks)) {
    for (const entry of entries ?? []) {
      const matcher = entry.matcher ? ` [${entry.matcher}]` : '';
      console.log(chalk.dim(`     ${event}${matcher}: ${entry.command}`));
    }
  }
  console.log(chalk.yellow(' Hooks run shell commands automatically. Trust this project? [y/N]'));
  const answer =
    process.stdout.isTTY && process.stdin.isTTY ? (await promptText(' > ')).toLowerCase() : 'n';
  if (answer === 'y' || answer === 'yes') {
    await recordTrust(cwd, projectHooks);
    console.log(chalk.dim(' Trusted. Will not prompt again unless the hook config changes.'));
    return;
  }
  // Strip the project hooks from the merged config. User hooks
  // (from ~/.factory/config.json) survive — those came from a
  // different file and aren't in question.
  if (config.agent?.hooks) {
    const userOnlyHooks: typeof config.agent.hooks = {};
    for (const [event, entries] of Object.entries(config.agent.hooks) as Array<
      [string, HookEntry[] | undefined]
    >) {
      const projectEntries = projectHooks[event as keyof typeof projectHooks] ?? [];
      const projectCommands = new Set(projectEntries.map(e => e.command));
      const filtered = (entries ?? []).filter(e => !projectCommands.has(e.command));
      if (filtered.length > 0) {
        (userOnlyHooks as Record<string, unknown>)[event] = filtered;
      }
    }
    config.agent.hooks = userOnlyHooks;
  }
  console.log(
    chalk.dim(' Project hooks rejected. Run with --no-hooks to silence this prompt entirely.'),
  );
}

/**
 * Register the Delegate tool when the `subagents` experimental flag is
 * on. The subagent runs on the provider's weak-tier model (Haiku /
 * Llama-3.1-8B / Gemini-Flash) when a mapping exists, falling back to
 * the parent's model otherwise.
 */
export async function registerSubagentTool(
  provider: Provider,
  parentModel: string,
  registry: ToolRegistry,
): Promise<void> {
  const [{ createDelegateTool }, { selectWeakTier }] = await Promise.all([
    import('../../tools/delegate.js'),
    import('../../core/agent/call-model/weak-tier.js'),
  ]);
  const weakModel = selectWeakTier(provider, parentModel);
  registry.register(
    createDelegateTool({
      provider,
      parentModel,
      ...(weakModel ? { weakModel } : {}),
    }),
  );
}
