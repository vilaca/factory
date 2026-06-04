/**
 * Headless runner for non-TTY contexts (piped stdin, CI, scripts).
 *
 * Reads the entire stdin as a single user prompt, runs one agent turn,
 * streams assistant text to stdout, sends tool/event diagnostics to
 * stderr, then exits. Permission prompts cannot be answered without a
 * TTY, so unallowed tool calls deny and the run exits non-zero with a
 * pointer to permissions.allowAll in config.
 */

import path from 'path';
import type { Provider } from '../providers/types.js';
import type { AgentConfig, BashRuleConfig } from '../core/config/types.js';
import type { PathPolicy } from '../security/paths.js';
import type { EnvPolicy } from '../security/env.js';
import { Conversation } from '../core/context/conversation.js';
import { ContextManager } from '../core/context/context-manager.js';
import { instrumentProviderRequests } from '../providers/instrument.js';
import { logModelRequestTo } from './session-bridge.js';
import { PermissionManager } from '../security/permissions.js';
import { runAgent } from '../core/agent/run-agent.js';
import type { ResponsesChain } from '../core/agent/types.js';
import { errorMessage } from '../utils/errors.js';
import { FileCache } from '../core/agent/cache/file-cache.js';
import type { ToolRegistry } from '../tools/registry.js';
import { createSessionLogger, type SessionLogger } from '../core/session/session-log.js';
import { getBuildInfo } from '../utils/build-info.js';
import {
  buildEnvironmentMessage,
  getScopedProjectInstructionsPrompt,
} from '../core/context/system-prompt.js';
import {
  createScopedProjectInstructionsState,
  refreshScopedProjectInstructionsFromToolCall,
} from '../core/context/scoped-project-instructions.js';
import { runHook } from '../core/hooks/index.js';
import type { AgentEvent } from '../core/agent/types.js';
import {
  describeRotationReason,
  fingerprintLabel,
  formatHookDisplay,
} from './agent-events/render.js';
import { resolveCompactionTarget } from './agent-events/compaction-resolver.js';
import {
  createDiagnosticEmitter,
  sessionLogDiagnosticSink,
  stderrDiagnosticSink,
  type DiagnosticEmitter,
} from './diagnostics.js';

interface HeadlessOptions {
  model: string;
  systemPrompt: string;
  provider: Provider;
  /** Per-session tool registry. Constructed in src/index.ts (with MCP
   *  and subagent tools registered into it) and passed in via
   *  appOptions. Replaces the previous process-global `defaultRegistry`
   *  import so a future multi-session daemon can hand each headless
   *  invocation a distinct tool set. */
  toolRegistry: ToolRegistry;
  agentConfig?: AgentConfig;
  autoAllowTools?: string[];
  bashRules?: BashRuleConfig[];
  useTextToolFallback?: boolean;
  nativeToolSupport?: boolean;
  enableSessionLog?: boolean;
  /** When true, session-log failures (init or first write) terminate the run
   *  with a dedicated exit code. For audit-grade workloads where a missing
   *  log is unacceptable. Off by default — logging stays best-effort. */
  strictLogging?: boolean;
  planMode?: boolean;
  enableCorrector?: boolean;
  mcpInfo?: { servers: string[]; toolCount: number };
  gitBranch?: string;
  gitDirty?: boolean | null;
  /** Startup instruction files loaded into the base prompt (currently .factory/INSTRUCTIONS.md). */
  loadedFiles?: Set<string>;
  /** Path / env security policies. Threaded in from index.ts (which loads
   *  them from config). Snapshotting them here means tests and parallel
   *  callers can vary policy per run instead of mutating process state. */
  pathPolicy?: PathPolicy;
  envPolicy?: EnvPolicy;
  /** Compaction-target override from --compaction-model. When unset, the
   *  compaction summary call routes to the primary (provider, model) —
   *  this matches the spec's "if --compaction-model NOT set use the
   *  primary provider/model for compaction" rule. When set with a
   *  cross-provider tuple, the resolver instantiates the target
   *  provider on demand the same way swap.ts does. */
  compactionModel?: { providerName: string; model: string };
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

function formatArgsBrief(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    const str = typeof v === 'string' ? v : JSON.stringify(v);
    const oneLine = str.split('\n')[0] ?? '';
    const truncated = oneLine.length > 80 ? oneLine.slice(0, 80) + '…' : oneLine;
    parts.push(`${k}=${truncated}`);
  }
  return parts.join(' ');
}

function formatScopedInstructionFiles(files: string[], projectRoot: string): string {
  return files
    .map(file => {
      const rel = path.relative(projectRoot, file);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return file;
      return rel;
    })
    .join(', ');
}

/** Side-effect log of one agent event to stdout/stderr for the headless
 *  runner. Returns the (possibly updated) {exitCode, permissionDeniedTool}
 *  so the caller can thread state through the for-await loop without
 *  hoisting the giant switch into the main function body. */
// eslint-disable-next-line complexity -- exhaustive switch over AgentEvent variants; each case is a one-liner.
function handleAgentEvent(
  event: AgentEvent,
  state: { exitCode: number; permissionDeniedTool: string | undefined },
  diagnostics: DiagnosticEmitter,
  projectRoot: string,
): void {
  switch (event.type) {
    case 'text-chunk':
      process.stdout.write(event.content);
      break;
    case 'tool-call-start':
      process.stderr.write(`▶ ${event.toolName} ${formatArgsBrief(event.args)}\n`);
      break;
    case 'tool-call-result': {
      // Always emit the completion marker — pairs with the `▶ start` line
      // above so a piped run isn't missing one half of every call.
      process.stderr.write(`  ${event.result.success ? '✓' : '✗'} ${event.toolName}\n`);
      // Surface the body for tool failures (success=false) and for
      // results flagged as `important` (e.g. Bash non-zero exit). Without
      // this a piped run sees just `✗ Bash` with no clue why — or `✓ Bash`
      // hiding a non-zero exit code. Successful non-error bodies stay
      // suppressed; the model has them and the piped stdout isn't the
      // place for verbose tool output.
      if (!event.result.success || event.result.important) {
        for (const line of event.result.output.split('\n')) {
          process.stderr.write(`    ${line}\n`);
        }
      }
      break;
    }
    case 'tool-call-denied':
      process.stderr.write(`  (denied: ${event.toolName})\n`);
      break;
    case 'permission-request':
      // Non-TTY: nobody to answer. Deny and surface a clear pointer.
      state.permissionDeniedTool = event.toolName;
      event.respond('deny');
      break;
    case 'hook-fired': {
      const { display, suffix } = formatHookDisplay(event.hookCommand, event.notice);
      process.stderr.write(`  ↪ ${event.event} hook (${display})${suffix}\n`);
      break;
    }
    case 'hook-veto': {
      const reason = event.errorMessage ? ` — ${event.errorMessage}` : '';
      diagnostics.warning(
        `  ⛔ ${event.event} hook vetoed ${event.toolName}${reason}`,
        'hook-veto',
      );
      break;
    }
    case 'hook-error':
      diagnostics.warning(`  ⚠ Hook ${event.event}: ${event.error}`, 'hook-error');
      break;
    case 'compaction-start':
      process.stderr.write(
        event.aggressive ? '  ⊕ aggressively compacting…\n' : '  ⊕ compacting…\n',
      );
      break;
    case 'compaction':
      process.stderr.write(
        `  ✓ compacted ${event.oldMessages} → ${event.newMessages}` +
          (event.aggressive ? ' (aggressive)\n' : '\n'),
      );
      break;
    case 'key-rotation': {
      const fromLabel = event.from ? fingerprintLabel(event.from) : '<unknown>';
      const toLabel = fingerprintLabel(event.to);
      const reasonLabel = describeRotationReason(event.reason);
      process.stderr.write(`  ⟲ key ${fromLabel} ${reasonLabel}, rotating to ${toLabel}\n`);
      break;
    }
    case 'key-rotation-exhausted': {
      const reasonLabel = describeRotationReason(event.reason);
      process.stderr.write(`  ⟲ no more keys for ${event.provider} (${reasonLabel})\n`);
      break;
    }
    case 'tuple-rotation': {
      const reasonLabel = describeRotationReason(event.reason);
      process.stderr.write(
        `  ⟲ ${event.from.provider}/${event.from.model} ${reasonLabel}, falling back to ${event.to.provider}/${event.to.model}\n`,
      );
      break;
    }
    case 'tuple-rotation-exhausted': {
      const reasonLabel = describeRotationReason(event.reason);
      process.stderr.write(`  ⟲ rotation chain exhausted (${reasonLabel})\n`);
      break;
    }
    case 'provider-retry': {
      // Surface the in-flight retry so CI logs aren't silent during a
      // multi-second backoff. The TTY path shows this on the StatusBar;
      // here the equivalent affordance is a single labeled stderr line.
      const seconds = (event.delayMs / 1000).toFixed(1);
      process.stderr.write(
        `  [activity] retrying ${event.attempt}/${event.maxAttempts} (${event.reason}, ${seconds}s)\n`,
      );
      break;
    }
    case 'auto-retry-exhausted':
      // Model bailed after a tool failure and couldn't recover. Piped
      // output may be truncated mid-task — surface so CI doesn't treat
      // a partial response as a successful one.
      diagnostics.warning(
        "  ⚠ auto-retry exhausted — model couldn't recover",
        'auto-retry-exhausted',
      );
      break;
    case 'all-denied-halt':
      diagnostics.warning(
        `  ⏸ all ${event.count} tool call${event.count === 1 ? '' : 's'} this turn were denied — halting`,
        'all-denied-halt',
      );
      break;
    case 'scoped-project-instructions-updated': {
      const names = formatScopedInstructionFiles(event.files, projectRoot);
      const suffix = names.length > 0 ? `: ${names}` : '';
      diagnostics.info(
        `loaded scoped project instructions${suffix}`,
        'project-instructions-scoped',
      );
      break;
    }
    case 'output-cap-reached':
      // Response was truncated at the provider's completion-token cap.
      // The caller's piped stdout is incomplete — flag it so `factory <
      // prompt > out.md` doesn't silently produce a half-document.
      diagnostics.warning(
        `  ⚠ output cap reached (${event.completionTokens} tokens) — response truncated`,
        'output-cap-reached',
      );
      break;
    case 'output-blocked':
      // Provider's policy classifier blocked the response (OpenAI
      // content_filter) or the model refused mid-turn (Anthropic
      // refusal). Distinct from a natural stop — surface so scripted
      // callers don't treat the partial output as authoritative.
      diagnostics.warning(
        `  ⚠ output blocked by provider (${event.reason}) — partial response only`,
        'output-blocked',
      );
      break;
    case 'empty-turn-warning':
      diagnostics.warning(
        `  ⚠ ${event.completionTokens} tokens of internal reasoning, no visible output`,
        'empty-turn-warning',
      );
      break;
    case 'repetition-detected':
      diagnostics.warning(
        `  ⚠ runaway repetition (${event.streak} identical lines) — turn aborted`,
        'repetition-detected',
      );
      break;
    case 'tool-result-imitation-stripped':
      // Security signal: the model fabricated tool result blocks in the
      // stream. The fakes are stripped before storing, but a piped run
      // shouldn't trust the output without knowing this happened.
      diagnostics.warning(
        `  ⚠ stripped ${event.count} fabricated tool-result block${event.count === 1 ? '' : 's'} from response`,
        'tool-result-imitation-stripped',
      );
      break;
    case 'error':
      diagnostics.error(`factory: ${event.error.message}`, 'agent-error');
      state.exitCode = 1;
      break;
    case 'turn-complete':
      if (event.stopReason === 'error') state.exitCode = state.exitCode || 1;
      else if (event.stopReason === 'token-limit') state.exitCode = state.exitCode || 5;
      break;
  }
}

// eslint-disable-next-line max-statements, complexity, sonarjs/cognitive-complexity -- TODO(complexity): split into setup / event-pump / shutdown phases.
export async function runHeadless(options: HeadlessOptions): Promise<void> {
  const userInput = await readAllStdin();
  if (!userInput) {
    process.stderr.write('factory: no input on stdin\n');
    process.exit(2);
  }

  // Dedicated exit code for log failures so callers can distinguish "agent
  // ran fine but log was unavailable" from generic errors (1).
  const STRICT_LOG_EXIT = 6;
  const cwd = process.cwd();

  let sessionLogger: SessionLogger | undefined;
  const diagnostics = createDiagnosticEmitter(
    stderrDiagnosticSink(),
    sessionLogDiagnosticSink(() => sessionLogger),
  );
  if (options.enableSessionLog !== false) {
    try {
      sessionLogger = createSessionLogger({
        onWriteError: options.strictLogging
          ? () => {
              // Stderr surface fired in session-log.ts; just escalate.
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

      // Emit startup instruction load via the shared diagnostics path so it
      // lands uniformly in stderr + session log.
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
    } catch (err: unknown) {
      // Logger init may fail (e.g. ~/.factory/sessions not writable, disk
      // full). Surface it on stderr — a piped run that thinks it's logging
      // when it isn't is a worse outcome than a noisy stderr line. Don't
      // abort by default: the run can still produce useful stdout, and the
      // session log is observability, not a hard dependency. Strict-log
      // callers (--strict-log) escalate to a dedicated exit code instead.
      process.stderr.write(`factory: session log unavailable — ${errorMessage(err)}\n`);
      if (options.strictLogging) process.exit(STRICT_LOG_EXIT);
      sessionLogger = undefined;
    }
  }

  const hooksEnabled = options.agentConfig?.experimental?.hooks ?? false;
  const scopedInstructionState = createScopedProjectInstructionsState(cwd);
  const onHookStderr = (hookCommand: string, chunk: string): void => {
    diagnostics.warning(`${hookCommand}: ${chunk.trim()}`, 'hook-stderr');
  };
  const onHookError = (event: string, error: string): void => {
    diagnostics.warning(`${event}: ${error}`, 'hook-error');
  };

  let sessionStartContext: string | undefined;
  if (hooksEnabled) {
    try {
      const r = await runHook(
        'SessionStart',
        { provider: options.provider.name, model: options.model, cwd },
        {
          cwd,
          config: options.agentConfig?.hooks,
          envPolicy: options.envPolicy,
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
      sessionStartContext = r.additionalContext;
    } catch (err: unknown) {
      onHookError('SessionStart', errorMessage(err));
    }
  }

  const conversation = new Conversation(
    options.systemPrompt,
    options.agentConfig?.maxToolResultTokens,
  );
  // Match the TUI seeding so the prefix shape is identical across modes —
  // see buildEnvironmentMessage docs for why this lives outside the
  // system prompt now.
  conversation.addUser(buildEnvironmentMessage(process.cwd()));
  conversation.addAssistant('Got it.');
  if (sessionStartContext) {
    conversation.addUser(sessionStartContext);
  }
  const permissions = new PermissionManager();
  for (const toolName of options.autoAllowTools ?? []) {
    permissions.allowAll(toolName);
  }
  // Headless runs have no UI to prompt for WebFetch; pre-seed the allowlist
  // from config so trusted domains skip the prompt and resolve to a fetch.
  // Anything not pre-allowed is auto-denied by the headless permission
  // handler below.
  for (const host of options.agentConfig?.web?.allowlist ?? []) {
    permissions.allowDomain(host);
  }
  if (options.bashRules?.length) {
    permissions.setBashRules(options.bashRules);
  }

  // Prime per-model caches the provider needs for an accurate
  // getCapabilities (ollama discovers the real context window via /show).
  // Done on the raw provider before wrapping — the instrumentation
  // wrapper's getCapabilities binds to inner, so the populated cache is
  // visible through the wrapped instance too.
  if (options.provider.primeModelCache) {
    await options.provider.primeModelCache(options.model);
  }
  // Wrap the provider so every chat / chatNoStream call lands in the session
  // log via logModelRequest. Mirrors the TUI's createInitialRefs wiring so the
  // headless and TUI modes produce comparable JSONL streams.
  const provider: Provider = sessionLogger
    ? instrumentProviderRequests(options.provider, info => logModelRequestTo(sessionLogger, info))
    : options.provider;
  const capabilities = provider.getCapabilities(options.model);
  // Headless never prompts — the resolver returns a fixed tuple every
  // call. Honors --compaction-model when supplied (cross-provider builds
  // and the error-fallback shape live in the shared resolver). When
  // unset, routes the summary call to the primary (provider, model).
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

  const state: { exitCode: number; permissionDeniedTool: string | undefined } = {
    exitCode: 0,
    permissionDeniedTool: undefined,
  };

  // Closure-state chain ref so multi-tool-call agentic runs can reuse
  // server-side reasoning across turns within the same headless invocation.
  // Chain lifetime is the runAgent call; reset hooks inside runAgent
  // (compaction, abort, rotation) clear it as needed.
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

  try {
    for await (const event of runAgent(userInput, {
      provider,
      model: options.model,
      conversation,
      permissions,
      toolRegistry: options.toolRegistry,
      contextManager,
      useTextToolFallback: options.useTextToolFallback,
      nativeToolSupport: options.nativeToolSupport,
      planMode: options.planMode,
      enableCorrector: options.enableCorrector,
      experimental: {
        bashDedup: options.agentConfig?.experimental?.bashDedup,
        readCache: options.agentConfig?.experimental?.readCache,
        hooks: hooksEnabled,
      },
      fileCache: new FileCache(),
      // Headless doesn't mutate cwd mid-turn (no Bash `cd` round-tripping in
      // a one-shot run), so a static holder is sufficient. The TUI passes a
      // live mutable holder updated by Bash; headless does not.
      cwdRef: { current: cwd },
      // Snapshot the policy at agent start so tools see it via ToolContext
      // and per-call hook fires use the same scrubbed env. The runtime no
      // longer reaches into a process-wide singleton; index.ts threads the
      // policy in via options.
      pathPolicy: options.pathPolicy ?? {},
      envPolicy: options.envPolicy ?? {},
      hooksConfig: options.agentConfig?.hooks,
      onHookStderr,
      onHookError,
      responsesChainRef,
      onToolCallStart: refreshScopedInstructions,
      onSuccessfulToolCall: refreshScopedInstructions,
    })) {
      sessionLogger?.logAgentEvent(event);
      handleAgentEvent(event, state, diagnostics, cwd);
    }
  } finally {
    process.stdout.write('\n');
    if (state.permissionDeniedTool && state.exitCode === 0) {
      process.stderr.write(
        `factory: tool '${state.permissionDeniedTool}' requires permission but stdin is not a TTY. ` +
          `Add '${state.permissionDeniedTool}' to permissions.allowAll in ~/.factory/config.json to allow it in headless mode.\n`,
      );
      state.exitCode = 3;
    }
    if (hooksEnabled) {
      try {
        const r = await runHook(
          'SessionEnd',
          { provider: options.provider.name, model: options.model, cwd },
          {
            cwd,
            config: options.agentConfig?.hooks,
            envPolicy: options.envPolicy,
            onStderr: onHookStderr,
          },
        );
        for (const e of r.errors) onHookError('SessionEnd', e);
      } catch (err: unknown) {
        onHookError('SessionEnd', errorMessage(err));
      }
    }
    sessionLogger?.logSessionEnd();
    sessionLogger?.close();
  }

  process.exit(state.exitCode);
}
