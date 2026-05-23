/**
 * Headless runner for non-TTY contexts (piped stdin, CI, scripts).
 *
 * Reads the entire stdin as a single user prompt, runs one agent turn,
 * streams assistant text to stdout, sends tool/event diagnostics to
 * stderr, then exits. Permission prompts cannot be answered without a
 * TTY, so unallowed tool calls deny and the run exits non-zero with a
 * pointer to permissions.allowAll in config.
 */

import type { Provider } from '../providers/types.js';
import type { AgentConfig, BashRuleConfig } from '../core/config/types.js';
import type { PathPolicy } from '../security/paths.js';
import type { EnvPolicy } from '../security/env.js';
import { Conversation } from '../core/context/conversation.js';
import { ContextManager } from '../core/context/context-manager.js';
import { createProvider, descriptorByAlias } from '../providers/registry.js';
import { instrumentProviderRequests } from '../providers/instrument.js';
import { logModelRequestTo } from './session-bridge.js';
import { getKey } from '../core/auth/credentials.js';
import { loadGlobalConfig } from '../core/config/index.js';
import { PermissionManager } from '../security/permissions.js';
import { runAgent } from '../core/agent/run-agent.js';
import type { ResponsesChain } from '../core/agent/types.js';
import { errorMessage } from '../utils/errors.js';
import { FileCache } from '../core/agent/cache/file-cache.js';
import { defaultRegistry } from '../tools/index.js';
import { createSessionLogger, type SessionLogger } from '../core/session/session-log.js';
import { getBuildInfo } from '../utils/build-info.js';
import { buildEnvironmentMessage } from '../core/context/system-prompt.js';
import { runHook } from '../core/hooks/index.js';
import type { AgentEvent } from '../core/agent/types.js';

interface HeadlessOptions {
  model: string;
  systemPrompt: string;
  provider: Provider;
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

/** Side-effect log of one agent event to stdout/stderr for the headless
 *  runner. Returns the (possibly updated) {exitCode, permissionDeniedTool}
 *  so the caller can thread state through the for-await loop without
 *  hoisting the giant switch into the main function body. */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- exhaustive switch over AgentEvent variants; each case is a one-liner.
function handleAgentEvent(
  event: AgentEvent,
  state: { exitCode: number; permissionDeniedTool: string | undefined },
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
      const name = event.hookCommand.split(/\s+/)[0] ?? event.hookCommand;
      const display = name.split('/').pop() ?? name;
      const suffix = event.notice ? ` — ${event.notice}` : '';
      process.stderr.write(`  ↪ ${event.event} hook (${display})${suffix}\n`);
      break;
    }
    case 'hook-veto': {
      const reason = event.errorMessage ? ` — ${event.errorMessage}` : '';
      process.stderr.write(`  ⛔ ${event.event} hook vetoed ${event.toolName}${reason}\n`);
      break;
    }
    case 'hook-error':
      process.stderr.write(`  ⚠ Hook ${event.event}: ${event.error}\n`);
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
      const fromLabel = event.from
        ? event.from.label
          ? `${event.from.label} · …${event.from.fingerprint}`
          : `…${event.from.fingerprint}`
        : '<unknown>';
      const toLabel = event.to.label
        ? `${event.to.label} · …${event.to.fingerprint}`
        : `…${event.to.fingerprint}`;
      const reasonLabel = event.reason === 'rate-limit' ? 'rate-limited' : 'auth failed';
      process.stderr.write(`  ⟲ key ${fromLabel} ${reasonLabel}, rotating to ${toLabel}\n`);
      break;
    }
    case 'key-rotation-exhausted': {
      const reasonLabel = event.reason === 'rate-limit' ? 'rate-limited' : 'auth failed';
      process.stderr.write(`  ⟲ no more keys for ${event.provider} (${reasonLabel})\n`);
      break;
    }
    case 'tuple-rotation': {
      const reasonLabel = event.reason === 'rate-limit' ? 'rate-limited' : 'auth failed';
      process.stderr.write(
        `  ⟲ ${event.from.provider}/${event.from.model} ${reasonLabel}, falling back to ${event.to.provider}/${event.to.model}\n`,
      );
      break;
    }
    case 'tuple-rotation-exhausted': {
      const reasonLabel = event.reason === 'rate-limit' ? 'rate-limited' : 'auth failed';
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
      process.stderr.write("  ⚠ auto-retry exhausted — model couldn't recover\n");
      break;
    case 'all-denied-halt':
      process.stderr.write(
        `  ⏸ all ${event.count} tool call${event.count === 1 ? '' : 's'} this turn were denied — halting\n`,
      );
      break;
    case 'output-cap-reached':
      // Response was truncated at the provider's completion-token cap.
      // The caller's piped stdout is incomplete — flag it so `factory <
      // prompt > out.md` doesn't silently produce a half-document.
      process.stderr.write(
        `  ⚠ output cap reached (${event.completionTokens} tokens) — response truncated\n`,
      );
      break;
    case 'output-blocked':
      // Provider's policy classifier blocked the response (OpenAI
      // content_filter) or the model refused mid-turn (Anthropic
      // refusal). Distinct from a natural stop — surface so scripted
      // callers don't treat the partial output as authoritative.
      process.stderr.write(
        `  ⚠ output blocked by provider (${event.reason}) — partial response only\n`,
      );
      break;
    case 'empty-turn-warning':
      process.stderr.write(
        `  ⚠ ${event.completionTokens} tokens of internal reasoning, no visible output\n`,
      );
      break;
    case 'repetition-detected':
      process.stderr.write(
        `  ⚠ runaway repetition (${event.streak} identical lines) — turn aborted\n`,
      );
      break;
    case 'tool-result-imitation-stripped':
      // Security signal: the model fabricated tool result blocks in the
      // stream. The fakes are stripped before storing, but a piped run
      // shouldn't trust the output without knowing this happened.
      process.stderr.write(
        `  ⚠ stripped ${event.count} fabricated tool-result block${event.count === 1 ? '' : 's'} from response\n`,
      );
      break;
    case 'error':
      process.stderr.write(`factory: ${event.error.message}\n`);
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

  let sessionLogger: SessionLogger | undefined;
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
  const cwd = process.cwd();
  const onHookStderr = (hookCommand: string, chunk: string): void => {
    sessionLogger?.logWarning('hook-stderr', `${hookCommand}: ${chunk.trim()}`);
  };
  const onHookError = (event: string, error: string): void => {
    sessionLogger?.logWarning('hook-error', `${event}: ${error}`);
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
        sessionLogger?.logWarning(
          'hook-fired',
          `SessionStart: ${hookCommand}${r.notice ? ` (${r.notice})` : ''}`,
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
  // call. Honors --compaction-model when supplied (possibly
  // cross-provider, in which case we instantiate the target provider on
  // demand). When unset, routes the summary call to the primary
  // (provider, model) — exact spec rule.
  const compactionResolver = async (): Promise<{
    provider: Provider;
    model: string;
  } | null> => {
    const target = options.compactionModel;
    if (!target || target.providerName === provider.name) {
      return { provider, model: target?.model ?? options.model };
    }
    try {
      const descriptor = descriptorByAlias(target.providerName);
      const createOpts: Parameters<typeof createProvider>[1] = {};
      if (descriptor) {
        const cfg = await loadGlobalConfig();
        const key = getKey(cfg, descriptor.name);
        if (key) {
          createOpts.token = key.token;
          if (descriptor.needsAccountId && key.extras?.accountId) {
            createOpts.accountId = key.extras.accountId;
          }
        }
      }
      const fresh = createProvider(target.providerName, createOpts);
      const wrapped = sessionLogger
        ? instrumentProviderRequests(
            fresh,
            info => logModelRequestTo(sessionLogger, info),
            'compaction',
          )
        : fresh;
      return { provider: wrapped, model: target.model };
    } catch (err: unknown) {
      // Same fallback shape as the TUI resolver — never block compaction
      // on auth/registry failures; the model call will trip the
      // mechanical-summary path.
      sessionLogger?.logWarning('compaction-resolver', errorMessage(err));
      return { provider, model: options.model };
    }
  };
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

  try {
    for await (const event of runAgent(userInput, {
      provider,
      model: options.model,
      conversation,
      permissions,
      toolRegistry: defaultRegistry,
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
    })) {
      sessionLogger?.logAgentEvent(event);
      handleAgentEvent(event, state);
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
