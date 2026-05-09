#!/usr/bin/env node

import chalk from 'chalk';
import type { StartupProviderName } from './providers/registry.js';
import { DESCRIPTOR_LIST } from './providers/registry.js';
import { loadConfig } from './core/config/index.js';
import { McpManager } from './mcp/client.js';
import { defaultRegistry } from './tools/index.js';
import { runHeadless } from './ui/headless.js';
import { renderApp } from './ui/tui/index.js';
import { buildSystemPrompt } from './core/context/system-prompt.js';
import { getLastSessionSelection, sessionsDir } from './core/session/session-log.js';
import { renderWelcome, renderError, animateLogo } from './ui/renderer.js';
import { errorMessage } from './utils/errors.js';
import { parseArgs, printUsage, printVersion } from './cli/args.js';
import {
  probeAllProviders,
  resolveCredentialsFor,
  type StartupCredentials,
} from './cli/auth/index.js';
import { buildExperimentalConfig } from './cli/startup/config.js';
import {
  applyRotationPhase,
  authenticateAndConnect,
  gatherGitState,
  handleProjectHookTrust,
  installShutdownHandlers,
  registerSubagentTool,
  resolveProvider,
  selectAndValidateModel,
} from './cli/startup/phases.js';

const SHUTDOWN_BUDGET_MS = 5000;

// eslint-disable-next-line max-statements, complexity -- main() is the orchestrator: each branch is a one-liner phase call. The remaining statements are sequential await calls that don't benefit from further splitting.
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

  await applyRotationPhase(config, cliArgs);

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

  const { providerName, resumeModel, resumeKeyId } = await resolveProvider(
    config,
    cliArgs,
    lastSession,
    credentials,
    probedModels,
  );

  const { provider, availableModels, activeKeyId } = await authenticateAndConnect(
    providerName,
    config,
    cliArgs,
    resumeKeyId,
    probedModels,
  );

  const { model, useTextToolFallback, validationWarning, validationMode } =
    await selectAndValidateModel(
      provider,
      providerName,
      config,
      resumeModel,
      lastSession,
      availableModels,
    );

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

  installShutdownHandlers({
    getMcpManager: () => mcpManager,
    budgetMs: SHUTDOWN_BUDGET_MS,
  });

  const { gitBranch, gitDirty } = await gatherGitState(cwd);

  await handleProjectHookTrust(config, cwd);

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
    await registerSubagentTool(provider, model, defaultRegistry);
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
    nativeToolSupport: validationMode === 'native',
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
