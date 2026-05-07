#!/usr/bin/env node

import chalk from 'chalk';
import type { Provider } from './providers/types.js';
import type { ProviderDescriptor, StartupProviderName } from './providers/descriptors.js';
import { DESCRIPTORS, DESCRIPTOR_LIST, descriptorByAlias } from './providers/descriptors.js';
import { createProvider } from './providers/registry.js';
import { loadConfig } from './core/config.js';
import type { HookEntry } from './core/config-types.js';
import { McpManager } from './mcp/client.js';
import { defaultRegistry } from './tools/index.js';
import { runHeadless } from './ui/headless.js';
import { renderApp } from './ui/ink/index.js';
import { buildSystemPrompt } from './core/system-prompt.js';
import { validateModelToolSupport } from './core/model-validation.js';
import { appendProviderLog, getLastSessionSelection, getRecentSessions, sessionsDir } from './core/session-log.js';
import { renderWelcome, renderError, animateLogo } from './ui/renderer.js';
import { getGitBranch, isGitDirty } from './utils/git.js';
import { errorMessage } from './utils/errors.js';
import { parseArgs, printUsage } from './cli/args.js';
import {
  ensureAuth,
  probeAllProviders,
  resolveCredentialsFor,
  saveCredentialsAfterModelDiscovery,
  type AuthResult,
  type StartupCredentials,
} from './cli/auth.js';
import {
  buildPickerOptions,
  findDefaultSelection,
} from './cli/picker.js';
import { selectStartupSession, selectModelInk } from './cli/startup-menu.js';

const DEBUG = process.env.FACTORY_DEBUG === '1';
function dbg(message: string): void {
  if (DEBUG) process.stderr.write(`[factory:debug] ${message}\n`);
}

function canResumeLastSession(
  last: { provider: string; model: string },
  probed: Map<StartupProviderName, string[] | null>,
): boolean {
  const descriptor = descriptorByAlias(last.provider);
  if (!descriptor) return false;
  const models = probed.get(descriptor.name);
  if (!models) return false;
  return models.includes(last.model);
}

async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv.slice(2));

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
  if (cliArgs.rotate !== undefined || cliArgs.saveRotate
      || cliArgs.noRotate || cliArgs.noRotateKeys || cliArgs.noRotateModels) {
    const { parseRotationChain } = await import('./cli/parse-rotation.js');
    const existing = config.agent?.rotation ?? {};
    const next = { ...existing };
    if (cliArgs.rotate !== undefined) {
      try {
        next.default = parseRotationChain(cliArgs.rotate);
      } catch (err: unknown) {
        console.log(renderError(errorMessage(err)));
        process.exit(1);
      }
    }
    if (cliArgs.noRotate) {
      next.keys = false;
      next.models = false;
    }
    if (cliArgs.noRotateKeys) next.keys = false;
    if (cliArgs.noRotateModels) next.models = false;
    config.agent = { ...config.agent, rotation: next };
    if (cliArgs.saveRotate) {
      try {
        // saveGlobalConfig does top-level shallow merge — preserve the rest
        // of `agent` by reading the existing global agent block and only
        // overriding the rotation field.
        const { loadGlobalConfig, saveGlobalConfig } = await import('./core/config.js');
        const global = await loadGlobalConfig();
        await saveGlobalConfig({
          agent: { ...global.agent, rotation: next },
        });
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

  if (config.provider) {
    providerName = config.provider;
  } else if (
    !cliArgs.pick &&
    lastSession &&
    canResumeLastSession(lastSession, probedModels)
  ) {
    // Fast path: jump straight into the prompt with the same provider/model
    // (and key) the user finished on. Use /pick or Ctrl+K mid-session to
    // change, or pass --pick to force the startup menu.
    dbg(`resuming last session: ${lastSession.provider}/${lastSession.model}${lastSession.keyId ? ` (key=${lastSession.keyId})` : ''}`);
    providerName = lastSession.provider;
    resumeModel = lastSession.model;
    resumeKeyId = lastSession.keyId;
  } else {
    const recentSessions = await getRecentSessions(10).catch(() => []);
    const startupOptions = buildPickerOptions(probedModels);
    const defaultFromLast = await findDefaultSelection(lastSession, probedModels, config, credentials);
    const fallbackDefault = startupOptions[0]
      ? { provider: startupOptions[0].descriptor.name }
      : { provider: 'copilot' as StartupProviderName };
    dbg(`opening picker (${recentSessions.length} recent, ${startupOptions.length} providers)`);
    const selection = await selectStartupSession(recentSessions, startupOptions, defaultFromLast ?? fallbackDefault);
    dbg(`picker returned provider=${selection.provider} model=${selection.model ?? '<none>'}`);
    providerName = selection.provider;
    resumeModel = selection.model ?? null;
  }

  const descriptor = descriptorByAlias(providerName) ?? (DESCRIPTORS as Record<string, ProviderDescriptor | undefined>)[providerName];
  let provider: Provider;
  let availableModels: string[] | null = descriptor ? probedModels.get(descriptor.name) ?? null : null;
  // The keyId of the multi-key-store entry the launch provider was built
  // with. Threaded through to RunRefs.activeKeyId so per-key stats land
  // under the right entry from turn 1; left undefined for non-store
  // credentials (CLI override, env var, OAuth, device flow).
  let activeKeyId: string | undefined;

  try {
    dbg(`ensureAuth flow=${descriptor?.authFlow ?? 'no-descriptor'}${resumeKeyId ? ` keyId=${resumeKeyId}` : ''}`);
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
      const savedKeyId = await saveCredentialsAfterModelDiscovery(descriptor, auth, availableModels.length > 0);
      // First-time-save path: addKey just minted a fresh id. Adopt it so
      // the first turn's stats land under the right key.
      if (savedKeyId) activeKeyId = savedKeyId;
    }
  } catch (err: unknown) {
    const msg = errorMessage(err);
    dbg(`startup error: ${msg}`);
    appendProviderLog({ provider: providerName, category: 'startup', action: 'startup-error', outcome: 'error', detail: msg });
    if (providerName === 'ollama') {
      console.log(renderError('Cannot connect to Ollama. Is it running? (ollama serve)'));
    } else if (providerName === 'llamacpp') {
      console.log(renderError('Cannot connect to llama.cpp. Is the server running? (llama-server -m <model>)'));
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

  const cleanup = async () => {
    if (mcpManager) await mcpManager.disconnect().catch(() => {});
    const { flushKeyStats } = await import('./core/key-stats.js');
    await flushKeyStats().catch(() => {});
  };
  process.on('SIGINT', () => { void cleanup().finally(() => process.exit(130)); });
  process.on('SIGTERM', () => { void cleanup().finally(() => process.exit(0)); });

  let gitBranch: string | undefined;
  let gitDirty: boolean | null = null;
  const [branchRes, dirtyRes] = await Promise.allSettled([getGitBranch(cwd), isGitDirty(cwd)]);
  if (branchRes.status === 'fulfilled') {
    gitBranch = branchRes.value;
  } else {
    const msg = branchRes.reason instanceof Error ? branchRes.reason.message : String(branchRes.reason);
    console.log(chalk.yellow(`  ⚠ Could not read git branch: ${msg}`));
  }
  if (dirtyRes.status === 'fulfilled') {
    gitDirty = dirtyRes.value;
  } else {
    const msg = dirtyRes.reason instanceof Error ? dirtyRes.reason.message : String(dirtyRes.reason);
    console.log(chalk.yellow(`  ⚠ Could not check git dirty state: ${msg}`));
  }

  // First-run trust check for project-local hooks. The merged config
  // already folds project hooks into `config.agent.hooks`, but we need the
  // project-only slice (without user-level entries) to fingerprint and
  // prompt against — user hooks are implicitly trusted (the user wrote
  // them in their own home dir).
  const { loadProjectConfig } = await import('./core/config.js');
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
      console.log(chalk.yellow(' Hooks run shell commands automatically. Trust this project? [y/N]'));
      const answer = process.stdout.isTTY && process.stdin.isTTY
        ? (await promptText(' > ')).toLowerCase()
        : 'n';
      if (answer === 'y' || answer === 'yes') {
        await recordTrust(cwd, projectHooks);
        console.log(chalk.dim(' Trusted. Will not prompt again unless the hook config changes.'));
      } else {
        // Strip the project hooks from the merged config. User hooks
        // (from ~/.factory/config.json) survive — those came from a
        // different file and aren't in question.
        if (config.agent?.hooks) {
          const userOnlyHooks: typeof config.agent.hooks = {};
          for (const [event, entries] of Object.entries(config.agent.hooks) as Array<[string, HookEntry[] | undefined]>) {
            const projectEntries = projectHooks[event as keyof typeof projectHooks] ?? [];
            const projectCommands = new Set(projectEntries.map(e => e.command));
            const filtered = (entries ?? []).filter(e => !projectCommands.has(e.command));
            if (filtered.length > 0) {
              (userOnlyHooks as Record<string, unknown>)[event] = filtered;
            }
          }
          config.agent.hooks = userOnlyHooks;
        }
        console.log(chalk.dim(' Project hooks rejected. Run with --no-hooks to silence this prompt entirely.'));
      }
    }
  }

  // Experimental flags default to on except for bashDedup, which is opt-in
  // for now. Config can override; CLI flags take final precedence.
  const experimentalFromConfig = config.agent?.experimental ?? {};
  const mergedAgentConfig = {
    ...config.agent,
    experimental: {
      bashDedup: false,
      readCache: true,
      lineCountHint: true,
      subagents: true,
      skills: false,
      hooks: true,
      ...experimentalFromConfig,
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
    },
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
    defaultRegistry.register(createDelegateTool({
      provider,
      parentModel: model,
      ...(weakModel ? { weakModel } : {}),
    }));
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

main().catch((err: unknown) => {
  console.error(renderError(errorMessage(err)));
  process.exit(1);
});
