import path from 'path';
import type { Provider } from '../../providers/types.js';
import { Conversation } from '../../core/context/conversation.js';
import { ContextManager } from '../../core/context/context-manager.js';
import { instrumentProviderRequests } from '../../providers/instrument.js';
import { logModelRequestTo } from '../session-bridge.js';
import { PermissionManager } from '../../security/permissions.js';
import type { ResponsesChain } from '../../core/agent/types.js';
import { errorMessage } from '../../utils/errors.js';
import { createSessionLogger, type SessionLogger } from '../../core/session/session-log.js';
import { getBuildInfo } from '../../utils/build-info.js';
import {
  buildEnvironmentMessage,
  getScopedProjectInstructionsPrompt,
} from '../../core/context/system-prompt.js';
import {
  createScopedProjectInstructionsState,
  refreshScopedProjectInstructionsFromToolCall,
} from '../../core/context/scoped-project-instructions.js';
import { runHook } from '../../core/hooks/index.js';
import { resolveCompactionTarget } from '../agent-events/compaction-resolver.js';
import {
  createDiagnosticEmitter,
  sessionLogDiagnosticSink,
  stderrDiagnosticSink,
  type DiagnosticEmitter,
} from '../diagnostics.js';
import type { HeadlessOptions, HeadlessRunState } from './types.js';
import { formatScopedInstructionFiles } from './io.js';
import type { EnvPolicy } from '../../security/env.js';

export interface HeadlessRuntime {
  cwd: string;
  provider: Provider;
  conversation: Conversation;
  permissions: PermissionManager;
  contextManager: ContextManager;
  hooksEnabled: boolean;
  sessionLogger: SessionLogger | undefined;
  diagnostics: DiagnosticEmitter;
  state: HeadlessRunState;
  responsesChainRef: {
    get: () => ResponsesChain | undefined;
    set: (v: ResponsesChain | undefined) => void;
  };
  onHookStderr: (hookCommand: string, chunk: string) => void;
  onHookError: (event: string, error: string) => void;
  refreshScopedInstructions: (info: {
    toolName: string;
    args: Record<string, unknown>;
    cwd: string;
  }) => Promise<{ changed: boolean; newFiles: string[] } | null>;
}

const STRICT_LOG_EXIT = 6;

function setupSessionLogger(
  options: HeadlessOptions,
  userInput: string,
  diagnostics: DiagnosticEmitter,
): SessionLogger | undefined {
  try {
    const sessionLogger = createSessionLogger({
      onWriteError: options.strictLogging
        ? () => {
            process.exit(STRICT_LOG_EXIT);
          }
        : undefined,
    });
    const build = getBuildInfo();
    sessionLogger.logSessionStart({
      model: options.model,
      provider: options.provider.name,
      cwd: process.cwd(),
      experimental: options.agentConfig?.experimental as Record<string, boolean> | undefined,
      turnTimeoutSec: options.agentConfig?.turnTimeoutSec,
      appVersion: build.version,
      buildTimestamp: build.buildTimestamp,
      mcp: options.mcpInfo,
      gitBranch: options.gitBranch,
      gitDirty: options.gitDirty,
    });

    const cwd = process.cwd();
    if (options.loadedFiles && options.loadedFiles.size > 0) {
      const fileNames = Array.from(options.loadedFiles)
        .map(f => path.relative(cwd, f))
        .join(', ');
      diagnostics.info(
        `Loaded startup project instructions from: ${fileNames}`,
        'project-instructions',
      );
    }

    sessionLogger.logUserInput(userInput);
    return sessionLogger;
  } catch (err: unknown) {
    process.stderr.write(`factory: session log unavailable — ${errorMessage(err)}\n`);
    if (options.strictLogging) process.exit(STRICT_LOG_EXIT);
    return undefined;
  }
}

async function executeSessionStartHooks(
  options: HeadlessOptions,
  diagnostics: DiagnosticEmitter,
  cwd: string,
  envPolicy: EnvPolicy | undefined,
): Promise<string | undefined> {
  const onHookStderr = (hookCommand: string, chunk: string): void => {
    diagnostics.warning(`${hookCommand}: ${chunk.trim()}`, 'hook-stderr');
  };
  const onHookError = (event: string, error: string): void => {
    diagnostics.warning(`${event}: ${error}`, 'hook-error');
  };

  try {
    const r = await runHook(
      'SessionStart',
      { provider: options.provider.name, model: options.model, cwd },
      {
        cwd,
        config: options.agentConfig?.hooks,
        envPolicy,
        onStderr: onHookStderr,
      },
    );
    for (const e of r.errors) onHookError('SessionStart', e);
    for (const hookCommand of r.firedCommands) {
      diagnostics.warning(
        `SessionStart: ${hookCommand}${r.notice ? ` (${r.notice})` : ''}`,
        'hook-fired',
      );
    }
    return r.additionalContext;
  } catch (err: unknown) {
    onHookError('SessionStart', errorMessage(err));
    return undefined;
  }
}

function setupPermissions(options: HeadlessOptions, permissions: PermissionManager): void {
  for (const toolName of options.autoAllowTools ?? []) {
    permissions.allowAll(toolName);
  }
  for (const host of options.agentConfig?.web?.allowlist ?? []) {
    permissions.allowDomain(host);
  }
  if (options.bashRules?.length) {
    permissions.setBashRules(options.bashRules);
  }
}

function instrumentProvider(
  provider: Provider,
  sessionLogger: SessionLogger | undefined,
): Provider {
  return sessionLogger
    ? instrumentProviderRequests(provider, info => logModelRequestTo(sessionLogger!, info))
    : provider;
}

export async function setupHeadlessRuntime(
  options: HeadlessOptions,
  userInput: string,
): Promise<HeadlessRuntime> {
  const cwd = process.cwd();
  const diagnostics = createDiagnosticEmitter(
    stderrDiagnosticSink(),
    sessionLogDiagnosticSink(() => sessionLogger),
  );

  const sessionLogger =
    options.enableSessionLog !== false
      ? setupSessionLogger(options, userInput, diagnostics)
      : undefined;

  const hooksEnabled = options.agentConfig?.experimental?.hooks ?? false;
  const scopedInstructionState = createScopedProjectInstructionsState(cwd);
  const onHookStderr = (hookCommand: string, chunk: string): void => {
    diagnostics.warning(`${hookCommand}: ${chunk.trim()}`, 'hook-stderr');
  };
  const onHookError = (event: string, error: string): void => {
    diagnostics.warning(`${event}: ${error}`, 'hook-error');
  };

  const sessionStartContext = hooksEnabled
    ? await executeSessionStartHooks(options, diagnostics, cwd, options.envPolicy)
    : undefined;

  const conversation = new Conversation(
    options.systemPrompt,
    options.agentConfig?.maxToolResultTokens,
  );
  conversation.addUser(buildEnvironmentMessage(process.cwd()));
  conversation.addAssistant('Got it.');
  if (sessionStartContext) {
    conversation.addUser(sessionStartContext);
  }

  const permissions = new PermissionManager();
  setupPermissions(options, permissions);

  if (options.provider.primeModelCache) {
    await options.provider.primeModelCache(options.model);
  }
  const provider: Provider = instrumentProvider(options.provider, sessionLogger);
  const capabilities = provider.getCapabilities(options.model);
  const compactionResolver = (): Promise<{ provider: Provider; model: string }> =>
    resolveCompactionTarget({
      active: { provider, model: options.model, sessionLogger },
      target: options.compactionModel,
    });
  const contextManager = new ContextManager(
    conversation,
    capabilities,
    {
      compactionThreshold: options.agentConfig?.compactionThreshold,
      recencyWindow: options.agentConfig?.recencyWindow,
      recencyTokens: options.agentConfig?.recencyTokens,
      toolResultAgingTurns: options.agentConfig?.toolResultAgingTurns,
    },
    compactionResolver,
  );

  const state: HeadlessRunState = {
    exitCode: 0,
    permissionDeniedTool: undefined,
  };

  let responsesChain: ResponsesChain | undefined;
  const responsesChainRef = {
    get: () => responsesChain,
    set: (v: ResponsesChain | undefined) => {
      responsesChain = v;
    },
  };

  const refreshScopedInstructions = async (info: {
    toolName: string;
    args: Record<string, unknown>;
    cwd: string;
  }): Promise<{ changed: boolean; newFiles: string[] } | null> => {
    const refresh = await refreshScopedProjectInstructionsFromToolCall(
      scopedInstructionState,
      { toolName: info.toolName, args: info.args },
      info.cwd,
    );
    if (refresh.changed) {
      const scoped = getScopedProjectInstructionsPrompt(scopedInstructionState.scopedInstructions);
      const next = scoped ? `${options.systemPrompt}\n\n${scoped}` : options.systemPrompt;
      conversation.updateSystemPrompt(next);
    }
    return refresh;
  };

  const preTurnRefresh = await refreshScopedInstructions({
    toolName: 'TurnStart',
    args: {},
    cwd,
  });
  if (preTurnRefresh?.changed) {
    const names = formatScopedInstructionFiles(preTurnRefresh.newFiles, cwd);
    const suffix = names.length > 0 ? `: ${names}` : '';
    diagnostics.info(`loaded scoped project instructions${suffix}`, 'project-instructions-scoped');
  }

  return {
    cwd,
    provider,
    conversation,
    permissions,
    contextManager,
    hooksEnabled,
    sessionLogger,
    diagnostics,
    state,
    responsesChainRef,
    onHookStderr,
    onHookError,
    refreshScopedInstructions,
  };
}
