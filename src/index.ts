#!/usr/bin/env node

import chalk from 'chalk';
import type { Provider } from './providers/types.js';
import type { ProviderDescriptor, StartupProviderName } from './providers/descriptors.js';
import { DESCRIPTORS, DESCRIPTOR_LIST, descriptorByAlias } from './providers/descriptors.js';
import { createProvider } from './providers/registry.js';
import { loadConfig } from './core/config/index.js';
import type { HookEntry } from './core/config/types.js';
import { McpManager } from './mcp/client.js';
import { defaultRegistry } from './tools/index.js';
import { runHeadless } from './ui/headless.js';
import { renderApp } from './ui/ink/index.js';
import { buildSystemPrompt } from './core/system-prompt.js';
import { validateModelToolSupport } from './core/model-validation.js';
import {
  appendProviderLog,
  getLastSessionSelection,
  getRecentSessions,
  sessionsDir,
} from './core/session-log.js';
import { renderWelcome, renderError, animateLogo } from './ui/renderer.js';
import { getGitBranch, isGitDirty } from './utils/git.js';
import { errorMessage } from './utils/errors.js';
import { parseArgs, printUsage, printVersion } from './cli/args.js';
import {
  ensureAuth,
  probeAllProviders,
  resolveCredentialsFor,
  saveCredentialsAfterModelDiscovery,
  type AuthResult,
  type StartupCredentials,
} from './cli/auth.js';
import { buildPickerOptions, findDefaultSelection } from './cli/picker.js';
import { selectStartupSession, selectModelInk } from './cli/startup-menu.js';
import { parseRotationChain } from './cli/parse-rotation.js';
import {
  applyCliRotationOverrides,
  buildExperimentalConfig,
  decideStartupSource,
  persistRotationConfig,
} from './cli/startup-config.js';
import { withBoundedTimeout } from './utils/timeout.js';

function dbg(message: string): void {
  if (process.env.FACTORY_DEBUG === '1') process.stderr.write(`[factory:debug] ${message}\n`);
}

// eslint-disable-next-line max-lines-per-function, max-statements, complexity, sonarjs/cognitive-complexity -- TODO(complexity): split startup phases (rotation / auth / picker / mode dispatch).
async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv.slice(2));

  if (cliArgs.debug) {
    process.env.FACTORY_DEBUG = '1';
  }

  if (cliArgs.version) {
    printVersion();
    process.exit(0);
  }

  if (cliArgs.help) {
    printUsage();
    process.exit(0);
  }

  if (process.stdout.isTTY && !cliArgs.noClear) {
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  }

  const cwd = process.cwd();

  const config = await loadConfig(cwd, {
    provider: cliArgs.provider,
    model: cliArgs.model,
    host: cliArgs.host,
    token: cliArgs.token,
  });

  // Apply CLI rotation overrides to the in-memory config before everything
  // else reads from it. --save-rotate also writes the parsed chain through
  // to global config so the next launch keeps it.
  if (
    cliArgs.rotate !== undefined ||
    cliArgs.saveRotate ||
    cliArgs.noRotate ||
    cliArgs.noRotateKeys ||
    cliArgs.noRotateModels
  ) {
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
        const { loadGlobalConfig, saveGlobalConfig } = await import('./core/config/index.js');
        await persistRotationConfig(next, loadGlobalConfig, saveGlobalConfig);
      } catch (err: unknown) {
        console.log(renderError(`Failed to save rotation config: ${errorMessage(err)}`));
        process.exit(1);
      }
    }
  }

  // Hold security policies as locals; they're threaded into appOptions /
  // headless options below so each session/tab sees them via ToolContext
  // and RunRefs (no process-global singleton).
  const pathPolicy = config.security?.paths ?? {};
  const envPolicy = config.security?.bashEnv ?? {};

  const lastSession = await getLastSessionSelection().catch(() => null);

  const credentials = new Map<StartupProviderName, StartupCredentials>(
    DESCRIPTOR_LIST.map(d => [d.name, resolveCredentialsFor(d, config, cliArgs.token)]),
  );
  const probedModels = await probeAllProviders(config, credentials);

  let providerName: string;
  let resumeModel: string | null = null;
  let resumeKeyId: string | undefined;
  const source = decideStartupSource(config, cliArgs, lastSession, probedModels);
  if (source.kind === 'config') {
    providerName = source.provider;
  } else if (source.kind === 'last-session') {
    dbg(
      `resuming last session: ${source.provider}/${source.model}${source.keyId ? ` (key=${source.keyId})` : ''}`,
    );
    providerName = source.provider;
    resumeModel = source.model;
    resumeKeyId = source.keyId;
  } else {
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
    providerName = selection.provider;
    resumeModel = selection.model ?? null;
  }

  const descriptor =
    descriptorByAlias(providerName) ??
    (DESCRIPTORS as Record<string, ProviderDescriptor | undefined>)[providerName];
  let provider: Provider;
  let availableModels: string[] | null = descriptor
    ? (probedModels.get(descriptor.name) ?? null)
    : null;
  // The keyId of the multi-key-store entry the launch provider was built
  // with. Threaded through to RunRefs.activeKeyId so per-key stats land
  // under the right entry from turn 1; left undefined for non-store
  // credentials (CLI override, env var, OAuth, device flow).
  let activeKeyId: string | undefined;

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

  let model: string;
  if (config.model) {
    model = config.model;
    dbg(`model from config: ${model}`);
  } else if (resumeModel && availableModels?.includes(resumeModel)) {
    model = resumeModel;
    dbg(`resuming model from picker: ${model}`);
  } else {
    const lastModelForProvider = lastSession?.provider === providerName ? lastSession.model : null;
    dbg(`opening selectModel (default=${lastModelForProvider ?? '<none>'})`);
    model = await selectModelInk(
      availableModels ?? [],
      lastModelForProvider,
      provider,
      providerName,
    );
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
  const validationWarning = useTextToolFallback ? validation.warning : undefined;

  const modelTier = provider.getCapabilities(model).modelTier;
  const systemPrompt = await buildSystemPrompt(cwd, modelTier);

  let mcpManager: McpManager | undefined;
  let mcpInfo: { servers: string[]; toolCount: number } | undefined;
  if (config.mcp?.servers?.length) {
    mcpManager = new McpManager();
    const mcpTools = await mcpManager.connectAll(config.mcp.servers);
    for (const tool of mcpTools) {
      defaultRegistry.register(tool);
    }
    mcpInfo = {
      servers: config.mcp.servers.map(s => (s as { name?: string }).name ?? '<unnamed>'),
      toolCount: mcpTools.length,
    };
  }

  // Cleanup must complete inside a hard wall-clock budget. Without it, an
  // MCP server that hangs on `close()` (or a flushKeyStats() that races
  // with a fs lock) holds the agent loop indefinitely after Ctrl-C —
  // observed in practice when servers fall over before their close handler
  // runs. The race below caps total cleanup time and surfaces what was
  // still in flight when the deadline hit.
  const SHUTDOWN_BUDGET_MS = 5000;
  const cleanup = async (): Promise<void> => {
    const pending: string[] = [];
    if (mcpManager) {
      const { pending: stuck } = await mcpManager.disconnect().catch(() => ({ pending: [] }));
      for (const name of stuck) pending.push(`mcp:${name}`);
    }
    const flushDone = (async () => {
      const { flushKeyStats } = await import('./core/key-stats.js');
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
    withBoundedTimeout(cleanup, SHUTDOWN_BUDGET_MS, () => {
      process.stderr.write(`shutdown: cleanup exceeded ${SHUTDOWN_BUDGET_MS}ms, forcing exit\n`);
    }).then(() => undefined);
  process.on('SIGINT', () => {
    void boundedCleanup().finally(() => process.exit(130));
  });
  process.on('SIGTERM', () => {
    void boundedCleanup().finally(() => process.exit(0));
  });

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

  // First-run trust check for project-local hooks. The merged config
  // already folds project hooks into `config.agent.hooks`, but we need the
  // project-only slice (without user-level entries) to fingerprint and
  // prompt against — user hooks are implicitly trusted (the user wrote
  // them in their own home dir).
  const { loadProjectConfig } = await import('./core/config/index.js');
  const projectOnly = await loadProjectConfig(cwd);
  const projectHooks = projectOnly.agent?.hooks;
  if (projectHooks && Object.keys(projectHooks).length > 0) {
    const { isProjectTrusted, recordTrust } = await import('./core/hooks/trust.js');
    if (!(await isProjectTrusted(cwd, projectHooks))) {
      const { promptText } = await import('./cli/prompts.js');
      console.log('');
      console.log(chalk.yellow(' ⚠ This project declares hooks in .factory/config.json:'));
      for (const [event, entries] of Object.entries(projectHooks)) {
        for (const entry of entries ?? []) {
          const matcher = entry.matcher ? ` [${entry.matcher}]` : '';
          console.log(chalk.dim(`     ${event}${matcher}: ${entry.command}`));
        }
      }
      console.log(
        chalk.yellow(' Hooks run shell commands automatically. Trust this project? [y/N]'),
      );
      const answer =
        process.stdout.isTTY && process.stdin.isTTY ? (await promptText(' > ')).toLowerCase() : 'n';
      if (answer === 'y' || answer === 'yes') {
        await recordTrust(cwd, projectHooks);
        console.log(chalk.dim(' Trusted. Will not prompt again unless the hook config changes.'));
      } else {
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
          chalk.dim(
            ' Project hooks rejected. Run with --no-hooks to silence this prompt entirely.',
          ),
        );
      }
    }
  }

  // Experimental flags default to on except for bashDedup, which is opt-in
  // for now. Config can override; CLI flags take final precedence.
  const mergedAgentConfig = {
    ...config.agent,
    experimental: buildExperimentalConfig(config.agent?.experimental, cliArgs),
    ...(cliArgs.turnTimeoutSec !== undefined ? { turnTimeoutSec: cliArgs.turnTimeoutSec } : {}),
  };

  // The Delegate tool spawns a read-only research subagent. Default-on
  // since 7882677; flip off via --no-subagents or `experimental.subagents:
  // false`. Wire weakModel from selectWeakTier so the subagent runs on the
  // provider's cheap tier (Haiku / Llama-3.1-8B / Gemini-Flash) instead of
  // the parent's strong-tier model — investigations don't need frontier
  // capacity, and the cost saving compounds quickly when the parent fans
  // out delegate calls.
  //
  // sessionLogger isn't wired here because each tab owns its own logger
  // (created per-tab in createInitialRefs); a global registry-level
  // registration can't reach the right one. Subagent events still land in
  // the per-tab session log via the parent's recordHistory path; what's
  // missing is the *nested* `subagent` source tag in the JSONL. Tracked as
  // a follow-up — needs per-tab tool registration to fix properly.
  if (mergedAgentConfig.experimental.subagents) {
    const [{ createDelegateTool }, { selectWeakTier }] = await Promise.all([
      import('./tools/delegate.js'),
      import('./core/agent/weak-tier.js'),
    ]);
    const weakModel = selectWeakTier(provider, model);
    defaultRegistry.register(
      createDelegateTool({
        provider,
        parentModel: model,
        ...(weakModel ? { weakModel } : {}),
      }),
    );
  }

  const welcomeText = renderWelcome(
    model,
    cwd,
    mergedAgentConfig.experimental,
    cliArgs.noLog ? 'disabled' : sessionsDir(),
    gitBranch,
  );

  // Surface any hooks that will be active this session. With hooks
  // default-on, a stale entry in ~/.factory/config.json would otherwise
  // spawn silently. Listing once per startup is cheap and prevents that
  // footgun. Computed up front; printed below after the screen-clear so
  // the notice survives.
  let activeHookSummaries: string[] = [];
  if (mergedAgentConfig.experimental.hooks) {
    const { listAllHooks } = await import('./core/hooks/discovery.js');
    activeHookSummaries = listAllHooks(mergedAgentConfig.hooks).map(({ event, entry }) => {
      const matcher = entry.matcher ? ` [${entry.matcher}]` : '';
      return `${event}${matcher}: ${entry.command}`;
    });
  }

  const appOptions = {
    model,
    systemPrompt,
    provider,
    ...(activeKeyId ? { keyId: activeKeyId } : {}),
    agentConfig: mergedAgentConfig,
    autoAllowTools: config.permissions?.allowAll,
    bashRules: config.permissions?.bashRules,
    useTextToolFallback,
    nativeToolSupport: validation.mode === 'native',
    enableSessionLog: !cliArgs.noLog,
    strictLogging: cliArgs.strictLog,
    planMode: cliArgs.plan,
    enableCorrector: !cliArgs.noAutoCorrect,
    mcpInfo,
    gitBranch,
    gitDirty,
    validationWarning,
    pathPolicy,
    envPolicy,
  };

  const isInteractiveTty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  if (isInteractiveTty) {
    if (!cliArgs.noClear) {
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    }
    process.stdout.write('\n');
    await animateLogo();
    console.log(welcomeText);
    if (activeHookSummaries.length > 0) {
      console.log(chalk.dim(` Hooks active: ${activeHookSummaries.join(', ')}`));
    }
    const app = renderApp(appOptions);
    await app.waitUntilExit();
  } else {
    console.log(welcomeText);
    if (activeHookSummaries.length > 0) {
      console.log(chalk.dim(` Hooks active: ${activeHookSummaries.join(', ')}`));
    }
    if (validationWarning) {
      console.log(chalk.yellow(`  ⚠ ${validationWarning}`));
    }
    await runHeadless(appOptions);
  }
}

process.on('unhandledRejection', (reason: unknown) => {
  console.error(renderError(`unhandledRejection: ${errorMessage(reason)}`));
  process.exit(1);
});

process.on('uncaughtException', (err: Error) => {
  console.error(renderError(`uncaughtException: ${errorMessage(err)}`));
  process.exit(1);
});

main().catch((err: unknown) => {
  console.error(renderError(errorMessage(err)));
  process.exit(1);
});
