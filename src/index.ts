#!/usr/bin/env node

import chalk from 'chalk';
import type { Provider } from './providers/types.js';
import type { ProviderDescriptor, StartupProviderName } from './providers/descriptors.js';
import { DESCRIPTORS, DESCRIPTOR_LIST, descriptorByAlias } from './providers/descriptors.js';
import { createProvider } from './providers/registry.js';
import { loadConfig } from './core/config.js';
import { McpManager } from './mcp/client.js';
import { defaultRegistry } from './tools/index.js';
import { runHeadless } from './ui/headless.js';
import { renderApp } from './ui/ink/index.js';
import { buildSystemPrompt } from './core/system-prompt.js';
import { validateModelToolSupport } from './core/model-validation.js';
import { appendProviderLog, getLastSessionSelection, getRecentSessions, sessionsDir } from './core/session-log.js';
import { renderWelcome, renderError, animateLogo } from './ui/renderer.js';
import { getGitBranch, isGitDirty } from './utils/git.js';
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

  const lastSession = await getLastSessionSelection().catch(() => null);

  const credentials = new Map<StartupProviderName, StartupCredentials>(
    DESCRIPTOR_LIST.map(d => [d.name, resolveCredentialsFor(d, config, cliArgs.token)]),
  );
  const probedModels = await probeAllProviders(config, credentials);

  let providerName: string;
  let resumeModel: string | null = null;

  if (config.provider) {
    providerName = config.provider;
  } else if (
    !cliArgs.pick &&
    lastSession &&
    canResumeLastSession(lastSession, probedModels)
  ) {
    // Fast path: jump straight into the prompt with the same provider/model
    // the user finished on. Use /pick or Ctrl+K mid-session to change, or
    // pass --pick to force the startup menu.
    dbg(`resuming last session: ${lastSession.provider}/${lastSession.model}`);
    providerName = lastSession.provider;
    resumeModel = lastSession.model;
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

  try {
    dbg(`ensureAuth flow=${descriptor?.authFlow ?? 'no-descriptor'}`);
    const auth: AuthResult = descriptor
      ? await ensureAuth(descriptor, config, cliArgs.token)
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

    if (descriptor) {
      await saveCredentialsAfterModelDiscovery(descriptor, auth, availableModels.length > 0);
    }
  } catch (err: any) {
    dbg(`startup error: ${err.message}`);
    appendProviderLog({ provider: providerName, category: 'startup', action: 'startup-error', outcome: 'error', detail: err.message });
    if (providerName === 'ollama') {
      console.log(renderError('Cannot connect to Ollama. Is it running? (ollama serve)'));
    } else if (providerName === 'llamacpp') {
      console.log(renderError('Cannot connect to llama.cpp. Is the server running? (llama-server -m <model>)'));
    } else {
      console.log(renderError(err.message));
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

  // Experimental flags default to on except for bashDedup, which is opt-in
  // for now. Config can override; CLI flags take final precedence.
  const experimentalFromConfig = config.agent?.experimental ?? {};
  const mergedAgentConfig = {
    ...config.agent,
    experimental: {
      bashDedup: false,
      readCache: true,
      lineCountHint: true,
      ...experimentalFromConfig,
      ...(cliArgs.bashDedup ? { bashDedup: true } : {}),
      ...(cliArgs.noBashDedup ? { bashDedup: false } : {}),
      ...(cliArgs.readCache ? { readCache: true } : {}),
      ...(cliArgs.noReadCache ? { readCache: false } : {}),
      ...(cliArgs.lineCountHint ? { lineCountHint: true } : {}),
      ...(cliArgs.noLineCountHint ? { lineCountHint: false } : {}),
    },
    ...(cliArgs.turnTimeoutSec !== undefined ? { turnTimeoutSec: cliArgs.turnTimeoutSec } : {}),
  };

  const welcomeText = renderWelcome(
    model,
    cwd,
    mergedAgentConfig.experimental,
    cliArgs.noLog ? 'disabled' : sessionsDir(),
    gitBranch,
  );

  const appOptions = {
    model,
    systemPrompt,
    provider,
    agentConfig: mergedAgentConfig,
    autoAllowTools: config.permissions?.allowAll,
    useTextToolFallback,
    nativeToolSupport: validation.mode === 'native',
    enableSessionLog: !cliArgs.noLog,
    planMode: cliArgs.plan,
    enableCorrector: !cliArgs.noAutoCorrect,
    mcpInfo,
    gitBranch,
    gitDirty,
    validationWarning,
  };

  const isInteractiveTty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  if (isInteractiveTty) {
    if (!cliArgs.noClear) {
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    }
    process.stdout.write('\n');
    await animateLogo();
    console.log(welcomeText);
    const app = renderApp(appOptions);
    await app.waitUntilExit();
  } else {
    console.log(welcomeText);
    if (validationWarning) {
      console.log(chalk.yellow(`  ⚠ ${validationWarning}`));
    }
    await runHeadless(appOptions);
  }
}

main().catch((err) => {
  console.error(renderError(err.message));
  process.exit(1);
});
