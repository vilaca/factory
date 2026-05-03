import readline from 'readline';
import chalk from 'chalk';
import type { Provider } from '../providers/types.js';
import type { PermissionDecision } from '../core/agent-types.js';
import type { AgentConfig, ExperimentalFlagKey } from '../core/config-types.js';
import { EXPERIMENTAL_FLAG_KEYS } from '../core/config-types.js';
import { Conversation } from '../core/conversation.js';
import { ContextManager } from '../core/context-manager.js';
import { PermissionManager } from '../permissions.js';
import { runAgent } from '../core/agent.js';
import { FileCache } from '../core/agent/file-cache.js';
import { validateModelToolSupport } from '../core/model-validation.js';
import { getTextToolFallbackPrompt, getPlanModePrompt, getLineCountHintPrompt, getGitStatusSnippet } from '../core/system-prompt.js';
import { createSessionLogger, loadHistoryFromSessions, type SessionLogger } from '../core/session-log.js';
import { getBuildInfo } from '../utils/build-info.js';

interface PlannedToolCall {
  toolName: string;
  args: Record<string, unknown>;
}

const MAX_REPLAYS_PER_PROMPT = 2;

const TRIVIAL_PROMPTS = new Set([
  'ok', 'okay', 'yes', 'no', 'y', 'n', 'go', 'go on',
  'do it', 'do the call', 'do the calls', 'continue', 'next', 'sure',
]);

function parsePermissionInput(input: string): PermissionDecision {
  const normalized = input.trim().toLowerCase();
  if (normalized === 'y' || normalized === 'yes' || normalized === '') return 'allow';
  if (normalized === 'a' || normalized === 'allow' || normalized === 'allow all') return 'allow-all';
  return 'deny';
}

function isSubstantivePrompt(s: string): boolean {
  if (s.length >= 25) return true;
  return !TRIVIAL_PROMPTS.has(s.toLowerCase());
}

function formatArgValue(v: unknown): string {
  const str = typeof v === 'string' ? v : JSON.stringify(v);
  const firstLine = str.split('\n')[0];
  const moreLines = str.includes('\n') ? ' …' + (str.split('\n').length - 1) + ' more lines' : '';
  const truncated = firstLine.length > 100 ? firstLine.slice(0, 100) + '…' : firstLine;
  return truncated + moreLines;
}
import { defaultRegistry } from '../tools/index.js';
import { Spinner } from './spinner.js';
import { renderStatusLine } from './status-bar.js';
import {
  renderToolCall,
  renderToolResult,
  renderError,
  renderPermissionPrompt,
} from './renderer.js';

export interface ReplOptions {
  model: string;
  systemPrompt: string;
  provider: Provider;
  agentConfig?: AgentConfig;
  autoAllowTools?: string[];
  useTextToolFallback?: boolean;
  nativeToolSupport?: boolean;
  enableSessionLog?: boolean;
  sessionLogger?: SessionLogger;
  planMode?: boolean;
  enableCorrector?: boolean;
  mcpInfo?: { servers: string[]; toolCount: number };
  gitBranch?: string;
  gitDirty?: boolean | null;
}

export class Repl {
  private provider: Provider;
  private conversation: Conversation;
  private permissions: PermissionManager;
  private model: string;
  private agentConfig: AgentConfig;
  private contextManager: ContextManager;
  private rl!: readline.Interface;
  private spinner: Spinner;
  private sessionTurns = 0;
  private sessionToolCalls = 0;
  private consecutiveStuckTurns = 0;
  private useTextToolFallback: boolean;
  private nativeToolSupport: boolean;
  private baseSystemPrompt: string;
  private sessionLogger?: SessionLogger;
  private planMode: boolean;
  private plannedCalls: PlannedToolCall[] = [];
  private enableCorrector: boolean;
  private gitDirty: boolean | null;
  private lastSubstantivePrompt: string | null = null;
  private replayCounts: Map<string, number> = new Map();
  private tokenLimitReplayCounts: Map<string, number> = new Map();
  private fileCache: FileCache = new FileCache();
  private currentAbort?: AbortController;
  private state: 'idle' | 'running' | 'awaiting-permission' = 'idle';
  private inputQueue: string[] = [];
  private permissionResolver?: (decision: PermissionDecision) => void;

  constructor(options: ReplOptions) {
    this.provider = options.provider;
    this.baseSystemPrompt = options.systemPrompt;
    this.useTextToolFallback = options.useTextToolFallback ?? false;
    this.nativeToolSupport = options.nativeToolSupport ?? true;
    this.planMode = options.planMode ?? false;
    this.enableCorrector = options.enableCorrector ?? true;
    this.gitDirty = options.gitDirty ?? null;
    this.agentConfig = options.agentConfig ?? {};
    if (options.sessionLogger) {
      this.sessionLogger = options.sessionLogger;
    } else if (options.enableSessionLog !== false) {
      try {
        this.sessionLogger = createSessionLogger();
        const build = getBuildInfo();
        this.sessionLogger.logSessionStart({
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
      } catch (err: any) {
        console.log(chalk.dim(`  (session logging disabled: ${err.message})`));
      }
    }
    this.conversation = new Conversation(this.composeSystemPrompt());
    this.permissions = new PermissionManager();
    this.model = options.model;
    this.spinner = new Spinner();

    const capabilities = this.provider.getCapabilities(this.model);
    this.contextManager = new ContextManager(this.conversation, capabilities, {
      compactionThreshold: options.agentConfig?.compactionThreshold,
      recencyWindow: options.agentConfig?.recencyWindow,
    });

    // Apply permission presets from config
    if (options.autoAllowTools) {
      for (const toolName of options.autoAllowTools) {
        this.permissions.allowAll(toolName);
      }
    }
  }

  async start(): Promise<void> {
    const pastHistory = await loadHistoryFromSessions().catch(() => []);

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      history: pastHistory,
      historySize: Math.max(1000, pastHistory.length + 200),
      removeHistoryDuplicates: true,
    });
    this.rl.setPrompt(chalk.green.bold('> '));

    this.rl.on('line', (line) => { void this.onLine(line); });

    this.rl.on('close', () => {
      this.spinner.stop();
      this.sessionLogger?.logSessionEnd();
      this.sessionLogger?.close();
      console.log(chalk.dim('\n  Goodbye!'));
      process.exit(0);
    });

    if (this.sessionLogger) {
      console.log(chalk.dim(`  Session log: ${this.sessionLogger.filePath}`));
    }
    if (pastHistory.length > 0) {
      console.log(chalk.dim(`  Loaded ${pastHistory.length} prior input${pastHistory.length === 1 ? '' : 's'} (press up to recall).`));
    }

    this.rl.prompt();
  }

  private async onLine(line: string): Promise<void> {
    const trimmed = line.trim();

    // Awaiting permission decision: route the line to the resolver.
    if (this.state === 'awaiting-permission') {
      const decision = parsePermissionInput(trimmed);
      this.permissionResolver?.(decision);
      this.permissionResolver = undefined;
      // state → 'running' is set by the caller after the resolver fires.
      return;
    }

    if (!trimmed) {
      if (this.state === 'idle') this.rl.prompt();
      return;
    }

    // Always-immediate slash commands: /exit, /quit, /q (handled inside handleCommand
    // because they call process.exit). /cancel during running aborts; otherwise
    // it's just a no-op when no plan exists.
    if (this.state === 'running') {
      if (trimmed === '/cancel' && !this.planMode) {
        this.currentAbort?.abort();
        return;
      }
      if (trimmed === '/exit' || trimmed === '/quit' || trimmed === '/q') {
        process.exit(0);
      }
      this.inputQueue.push(trimmed);
      console.log(chalk.dim(`  📨 queued (${this.inputQueue.length} pending) — runs after current task.`));
      return;
    }

    // Idle: process the input now, then drain queue.
    await this.processInputAndDrain(trimmed);
  }

  private async processInputAndDrain(initial: string): Promise<void> {
    let next: string | undefined = initial;
    while (next !== undefined) {
      try {
        await this.processInput(next);
      } catch (err: any) {
        this.spinner.stop();
        console.log(renderError(err.message));
      }
      next = this.inputQueue.shift();
      if (next !== undefined) {
        console.log(chalk.dim(`  📨 processing queued: ${next.slice(0, 80)}${next.length > 80 ? '…' : ''}`));
      }
    }
    this.state = 'idle';
    this.rl.prompt();
  }

  private async processInput(trimmed: string): Promise<void> {
    if (this.planMode && this.plannedCalls.length > 0) {
      const lower = trimmed.toLowerCase();
      if (lower === 'y' || lower === 'yes' || lower === '/approve') {
        this.sessionLogger?.logCommand('/approve', '');
        await this.approveAndExecutePlan();
        return;
      }
      if (lower === 'n' || lower === 'no' || lower === '/cancel') {
        this.sessionLogger?.logCommand('/cancel', '');
        this.plannedCalls = [];
        console.log(chalk.dim('  Plan dropped. Still in plan mode.'));
        return;
      }
      if (!trimmed.startsWith('/')) {
        this.plannedCalls = [];
        console.log(chalk.dim('  (revising plan...)'));
      }
    }

    if (trimmed.startsWith('/')) {
      const [cmd, ...rest] = trimmed.split(' ');
      this.sessionLogger?.logCommand(cmd, rest.join(' '));
      const handled = await this.handleCommand(trimmed);
      if (handled) return;
    }

    this.sessionLogger?.logUserInput(trimmed);

    if (isSubstantivePrompt(trimmed)) {
      this.lastSubstantivePrompt = trimmed;
    }

    this.state = 'running';
    await this.runAgentLoop(trimmed);
  }

  private async handleCommand(input: string): Promise<boolean> {
    const [cmd, ...rest] = input.split(' ');
    const arg = rest.join(' ').trim();

    switch (cmd) {
      case '/exit':
      case '/quit':
      case '/q':
        console.log(chalk.dim('\n  Goodbye!'));
        process.exit(0);

      case '/clear':
        this.conversation.clear();
        console.log(chalk.dim('  Conversation cleared.'));
        return true;

      case '/model':
        if (arg) {
          const validation = await validateModelToolSupport(this.provider, arg);
          if (validation.mode === 'unreachable') {
            console.log(renderError(validation.reason));
            return true;
          }
          const prevFallback = this.useTextToolFallback;
          this.useTextToolFallback = validation.mode === 'fallback';
          this.nativeToolSupport = validation.mode === 'native';
          if (validation.mode === 'fallback') {
            console.log(chalk.yellow(`  ⚠ ${validation.warning}`));
          }
          if (prevFallback !== this.useTextToolFallback) {
            this.conversation.updateSystemPrompt(this.composeSystemPrompt());
            this.sessionLogger?.logSystemPromptChange(`text-tool-fallback=${this.useTextToolFallback}`);
          }
          this.sessionLogger?.logModelChange(this.model, arg);
          this.model = arg;
          const caps = this.provider.getCapabilities(arg);
          this.contextManager = new ContextManager(this.conversation, caps, {
            compactionThreshold: this.agentConfig.compactionThreshold,
            recencyWindow: this.agentConfig.recencyWindow,
          });
          console.log(chalk.dim(`  Model switched to ${arg}`));
          await this.printModelInfo(arg);
        } else {
          console.log(chalk.dim(`  Current model: ${this.model}`));
          await this.printModelInfo(this.model);
        }
        return true;

      case '/help':
        this.printHelp();
        return true;

      case '/permissions':
        this.permissions.reset();
        this.sessionLogger?.logPermissionChange('reset');
        console.log(chalk.dim('  Permissions reset.'));
        return true;

      case '/plan':
        if (this.plannedCalls.length > 0) {
          this.printPlanQueue();
        } else {
          this.planMode = !this.planMode;
          this.conversation.updateSystemPrompt(this.composeSystemPrompt());
          this.sessionLogger?.logSystemPromptChange(`plan-mode=${this.planMode}`);
          console.log(chalk.cyan(`  Plan mode: ${this.planMode ? 'ON' : 'OFF'}.`));
        }
        return true;

      case '/queue':
        this.printPlanQueue();
        return true;

      case '/log':
        if (this.sessionLogger) {
          console.log(chalk.dim(`  Session log: ${this.sessionLogger.filePath}`));
        } else {
          console.log(chalk.dim('  Session logging is disabled.'));
        }
        return true;

      case '/correct':
        if (arg === 'on') this.enableCorrector = true;
        else if (arg === 'off') this.enableCorrector = false;
        else if (arg) {
          console.log(chalk.dim('  Usage: /correct on|off'));
          return true;
        } else {
          this.enableCorrector = !this.enableCorrector;
        }
        console.log(chalk.dim(`  LLM tool-call corrector: ${this.enableCorrector ? 'ON' : 'OFF'}.`));
        return true;

      case '/exp':
        this.handleExpCommand(arg);
        return true;

      case '/approve':
        if (!this.planMode || this.plannedCalls.length === 0) {
          console.log(chalk.dim('  No plan to approve.'));
          return true;
        }
        await this.approveAndExecutePlan();
        return true;

      case '/cancel':
        if (this.planMode && this.plannedCalls.length > 0) {
          this.plannedCalls = [];
          console.log(chalk.dim('  Plan dropped.'));
        } else {
          console.log(chalk.dim('  No plan to cancel.'));
        }
        return true;

      default:
        console.log(chalk.dim(`  Unknown command: ${cmd}. Type /help for available commands.`));
        return true;
    }
  }

  private composeSystemPrompt(): string {
    const parts: string[] = [this.baseSystemPrompt];
    if (this.useTextToolFallback) parts.push(getTextToolFallbackPrompt());
    if (this.planMode) parts.push(getPlanModePrompt());
    if (this.agentConfig.experimental?.lineCountHint) parts.push(getLineCountHintPrompt());
    const git = getGitStatusSnippet(this.gitDirty);
    if (git) parts.push(git);
    return parts.join('\n\n');
  }

  private async printModelInfo(model: string): Promise<void> {
    const caps = this.provider.getCapabilities(model);
    console.log(chalk.dim(`    context window:  ${caps.contextWindow.toLocaleString()} tokens`));
    console.log(chalk.dim(`    estimated tier:  ${caps.modelTier}`));

    if (this.provider.getModelInfo) {
      try {
        const info = await this.provider.getModelInfo(model);
        const support = info.supportsTools ? chalk.green('native') : chalk.yellow('none');
        console.log(chalk.dim(`    tool support:    `) + support);
        if (info.capabilities && info.capabilities.length > 0) {
          console.log(chalk.dim(`    capabilities:    ${info.capabilities.join(', ')}`));
        }
      } catch (err: any) {
        console.log(chalk.dim(`    tool support:    `) + chalk.red(`unknown (${err.message})`));
      }
    } else {
      console.log(chalk.dim(`    tool support:    ${caps.toolSupport} (heuristic)`));
    }
  }

  private printHelp(): void {
    const lines = [
      '',
      chalk.bold('  Commands:'),
      chalk.cyan('  /exit, /quit, /q   ') + chalk.dim('Exit factory'),
      chalk.cyan('  /clear             ') + chalk.dim('Clear conversation history'),
      chalk.cyan('  /model <name>      ') + chalk.dim('Switch model (or show current)'),
      chalk.cyan('  /permissions       ') + chalk.dim('Reset tool permissions'),
      chalk.cyan('  /plan              ') + chalk.dim('Toggle plan mode (or show queue if one exists)'),
      chalk.cyan('  /queue             ') + chalk.dim('Show the queued plan'),
      chalk.cyan('  /log               ') + chalk.dim('Show the current session log path'),
      chalk.cyan('  /correct on|off    ') + chalk.dim('Toggle the LLM tool-call corrector'),
      chalk.cyan('  /exp [name on|off] ') + chalk.dim('List or toggle experimental flags'),
      chalk.cyan('  /approve, y        ') + chalk.dim('Execute the queued plan'),
      chalk.cyan('  /cancel, n         ') + chalk.dim('Drop the queued plan'),
      chalk.dim('  Esc                ') + chalk.dim('Abort current agent run'),
      chalk.cyan('  /help              ') + chalk.dim('Show this help'),
      '',
    ];
    console.log(lines.join('\n'));
  }

  private handleExpCommand(arg: string): void {
    const exp = this.agentConfig.experimental ?? {};
    if (!arg) {
      console.log(chalk.cyan.bold('  Experimental flags:'));
      for (const key of EXPERIMENTAL_FLAG_KEYS) {
        const state = exp[key] ? chalk.green('on') : chalk.dim('off');
        console.log(`    ${chalk.cyan(key.padEnd(18))} ${state}`);
      }
      console.log(chalk.dim('  Toggle: /exp <name> on|off'));
      return;
    }
    const parts = arg.split(/\s+/).filter(Boolean);
    if (parts.length < 1 || parts.length > 2) {
      console.log(chalk.dim('  Usage: /exp [<name> on|off]'));
      return;
    }
    const name = parts[0] as ExperimentalFlagKey;
    if (!EXPERIMENTAL_FLAG_KEYS.includes(name)) {
      console.log(chalk.yellow(`  Unknown flag "${name}". Known: ${EXPERIMENTAL_FLAG_KEYS.join(', ')}`));
      return;
    }
    let next: boolean;
    if (parts.length === 1) next = !exp[name];
    else if (parts[1] === 'on') next = true;
    else if (parts[1] === 'off') next = false;
    else {
      console.log(chalk.yellow(`  Invalid value "${parts[1]}". Use on or off.`));
      return;
    }
    this.agentConfig = {
      ...this.agentConfig,
      experimental: { ...exp, [name]: next },
    };
    if (name === 'lineCountHint') {
      this.conversation.updateSystemPrompt(this.composeSystemPrompt());
      this.sessionLogger?.logSystemPromptChange(`lineCountHint=${next}`);
    }
    console.log(chalk.dim(`  Experimental ${name}: ${next ? 'on' : 'off'}.`));
  }

  private printPlanQueue(): void {
    if (this.plannedCalls.length === 0) {
      console.log(chalk.dim('  No queued plan.'));
      return;
    }
    console.log(chalk.cyan.bold(`  Queued plan (${this.plannedCalls.length} call${this.plannedCalls.length === 1 ? '' : 's'}):`));
    this.plannedCalls.forEach((p, i) => {
      console.log(chalk.cyan(`  #${i + 1} `) + chalk.bold(p.toolName));
      for (const [k, v] of Object.entries(p.args)) {
        console.log(chalk.dim(`     ${k}: ${formatArgValue(v)}`));
      }
    });
    console.log(chalk.dim('  Type ') + chalk.bold('y') + chalk.dim(' to approve, ') + chalk.bold('n') + chalk.dim(' to drop, or describe revisions.'));
  }

  private async approveAndExecutePlan(): Promise<void> {
    const plan = this.plannedCalls;
    this.plannedCalls = [];
    this.planMode = false;
    this.conversation.updateSystemPrompt(this.composeSystemPrompt());
    this.sessionLogger?.logSystemPromptChange('plan-mode=false');
    console.log(chalk.cyan(`  Executing ${plan.length} planned tool call${plan.length === 1 ? '' : 's'}...`));
    const summary = plan
      .map(p => `- ${p.toolName}: ${JSON.stringify(p.args).slice(0, 200)}`)
      .join('\n');
    await this.runAgentLoop(`Execute the plan you proposed:\n${summary}\n\nIssue each tool call now.`);
  }

  private async runAgentLoop(userInput: string): Promise<void> {
    process.stdout.write('\n');

    this.currentAbort = new AbortController();
    const removeEscListener = this.installEscListener();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutSec = this.agentConfig.turnTimeoutSec;
    if (timeoutSec) {
      timeoutHandle = setTimeout(() => {
        console.log(chalk.yellow(`\n  ⏱ Turn timeout (${timeoutSec}s) — aborting.`));
        this.currentAbort?.abort();
      }, timeoutSec * 1000);
    }
    try {
      await this.runAgentLoopInner(userInput);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      removeEscListener();
      this.currentAbort = undefined;
    }
  }

  private async runAgentLoopInner(userInput: string): Promise<void> {
    let effectiveInput = userInput;
    if (this.consecutiveStuckTurns >= 2) {
      console.log(chalk.yellow(
        `  ↻ Detected stuck pattern (last ${this.consecutiveStuckTurns} replies were short with no tool calls) — injecting recovery nudge.`,
      ));
      effectiveInput =
        `[System nudge: your last ${this.consecutiveStuckTurns} responses were short prose with no tool calls, but the user keeps asking for action. Re-read this request carefully. If it asks for a code change, you MUST emit a tool call now — do not reply with prose. If you don't know where to start, call Glob, Grep, or Read to explore.]\n\n` +
        userInput;
      this.consecutiveStuckTurns = 0;
    }

    this.spinner.start('Thinking');

    let receivedText = false;
    let toolCallsThisRun = 0;
    let successfulToolCallsThisRun = 0;
    let autoRetryExhaustedThisRun = false;
    let tokenLimitHaltThisRun = false;
    let lastUsage: { completionTokens: number } | undefined;
    const capabilities = this.provider.getCapabilities(this.model);

    const agent = runAgent(effectiveInput, {
      provider: this.provider,
      model: this.model,
      conversation: this.conversation,
      permissions: this.permissions,
      toolRegistry: defaultRegistry,
      useTextToolFallback: this.useTextToolFallback,
      nativeToolSupport: this.nativeToolSupport,
      planMode: this.planMode,
      enableCorrector: this.enableCorrector,
      contextManager: this.contextManager,
      maxTurns: this.agentConfig.maxTurns,
      experimental: {
        bashDedup: this.agentConfig.experimental?.bashDedup,
        readCache: this.agentConfig.experimental?.readCache,
      },
      fileCache: this.fileCache,
      signal: this.currentAbort?.signal,
    });

    for await (const event of agent) {
      // text-chunk events fire many times per turn; defer logging to text-done
      // which carries the full assembled content as a single event.
      if (event.type !== 'text-chunk') {
        this.sessionLogger?.logAgentEvent(event);
      }
      switch (event.type) {
        case 'text-chunk':
          if (!receivedText) {
            this.spinner.stop();
            receivedText = true;
          }
          process.stdout.write(event.content);
          break;

        case 'text-done':
          process.stdout.write('\n');
          break;

        case 'tool-call-start':
          this.spinner.stop();
          receivedText = false;
          toolCallsThisRun++;
          console.log('');
          console.log(renderToolCall(event.toolName, event.args));
          break;

        case 'permission-request': {
          const decision = await this.promptPermission(event.toolName);
          this.sessionLogger?.logPermissionChange(`request:${decision}`, event.toolName);
          event.respond(decision);
          this.spinner.start('Running tool');
          break;
        }

        case 'tool-call-denied':
          this.spinner.stop();
          console.log(chalk.dim('  (denied)'));
          break;

        case 'tool-call-recovered':
          this.spinner.stop();
          if (!this.useTextToolFallback) {
            // First recovery in the session — surface what's happening, then
            // auto-promote so subsequent recoveries are routine and silent.
            const sourceLabel =
              event.source === 'bare' ? 'bare JSON' :
              event.source === 'fence' ? 'a JSON code block' :
              event.source === 'shell-fence' ? 'a shell code block' :
              'tagged JSON';
            console.log(chalk.yellow(
              `  ⚠ Model emitted tool call as ${sourceLabel} ` +
              `instead of structured tool_calls. Recovered ${event.count} call${event.count === 1 ? '' : 's'} via fallback parser.`,
            ));
            this.useTextToolFallback = true;
            this.conversation.updateSystemPrompt(this.composeSystemPrompt());
            this.sessionLogger?.logSystemPromptChange('text-tool-fallback=true (auto)');
            console.log(chalk.yellow(
              `  ⚠ Auto-enabling text-tool fallback mode — model will be instructed to use <tool_call> format from now on. Subsequent recoveries will be silent.`,
            ));
          }
          this.spinner.start('Running tool');
          break;

        case 'tool-result-imitation-stripped':
          this.spinner.stop();
          console.log(chalk.red(
            `  ⚠ Model fabricated ${event.count} tool result block${event.count === 1 ? '' : 's'} ` +
            `in its response. Stripped before storing — the result was NOT real.`,
          ));
          this.spinner.start('Thinking');
          break;

        case 'auto-retry-injected':
          this.spinner.stop();
          console.log(chalk.yellow(
            `  ↻ Model bailed after a tool failure — auto-injecting retry nudge ` +
            `(${event.remainingBudget} retr${event.remainingBudget === 1 ? 'y' : 'ies'} left).`,
          ));
          this.spinner.start('Thinking');
          break;

        case 'auto-retry-exhausted':
          this.spinner.stop();
          autoRetryExhaustedThisRun = true;
          console.log(chalk.yellow(
            `  ⚠ Auto-retry exhausted — model couldn't recover on its own.`,
          ));
          break;

        case 'all-denied-halt':
          this.spinner.stop();
          console.log(chalk.yellow(
            `  ⏸ All ${event.count} tool call${event.count === 1 ? '' : 's'} this turn were denied — halting. Tell the model what to do differently.`,
          ));
          break;

        case 'tool-call-corrected':
          this.spinner.stop();
          console.log(chalk.yellow(
            `  ↺ Auto-correcting ${event.original.function.name} call (${event.reason.slice(0, 80)})...`,
          ));
          this.spinner.start('Running tool');
          break;

        case 'tool-call-corrector-aborted':
          this.spinner.stop();
          console.log(chalk.dim(`  ↺ Corrector skipped: ${event.reason.slice(0, 100)}`));
          this.spinner.start('Thinking');
          break;

        case 'tool-call-planned': {
          this.spinner.stop();
          const sig = `${event.toolName}:${JSON.stringify(event.args)}`;
          const dup = this.plannedCalls.some(p => `${p.toolName}:${JSON.stringify(p.args)}` === sig);
          if (dup) {
            console.log(chalk.dim(`  [planned] (skipped duplicate ${event.toolName} call)`));
          } else {
            this.plannedCalls.push({ toolName: event.toolName, args: event.args });
            console.log(chalk.cyan(`  [planned #${this.plannedCalls.length}] `) + chalk.bold(event.toolName));
            for (const [k, v] of Object.entries(event.args)) {
              console.log(chalk.dim(`    ${k}: ${formatArgValue(v)}`));
            }
          }
          this.spinner.start('Thinking');
          break;
        }

        case 'tool-call-result':
          this.spinner.stop();
          console.log(renderToolResult(event.result.displayOutput ?? event.result.output, event.result.success, event.result.empty));
          this.spinner.start('Thinking');
          receivedText = false;
          this.sessionToolCalls++;
          if (event.result.success) successfulToolCallsThisRun++;
          break;

        case 'output-cap-reached':
          this.spinner.stop();
          console.log(chalk.yellow(
            `  ⚠ Output cap reached (${event.completionTokens} tokens). Response was truncated — ask for the rest if needed.`,
          ));
          break;

        case 'empty-turn-warning':
          this.spinner.stop();
          console.log(chalk.yellow(
            `  ⚠ Model produced ${event.completionTokens} tokens of internal reasoning but no visible output. ` +
            `This is a thinking-mode runaway — try a different model or a more concrete prompt.`,
          ));
          break;

        case 'repetition-detected':
          this.spinner.stop();
          console.log(chalk.red(
            `  ⚠ Runaway repetition detected (${event.streak} identical lines: ${chalk.dim(event.line.slice(0, 60))}). Aborting.`,
          ));
          break;

        case 'read-cache-hit':
          this.spinner.stop();
          console.log(chalk.dim(`  ⤳ Read cache hit: ${event.path} unchanged`));
          this.spinner.start('Thinking');
          break;

        case 'bash-dedup-nudge':
          this.spinner.stop();
          console.log(chalk.yellow(
            `  ↻ Near-duplicate Bash pattern detected (${event.recentCommands.length} recent). Injected a nudge to step back.`,
          ));
          this.spinner.start('Thinking');
          break;

        case 'compaction-start':
          this.spinner.stop();
          console.log(chalk.dim(
            event.aggressive
              ? '  ⊕ Context full — aggressively compacting (mechanical summary)…'
              : '  ⊕ Compacting conversation history…',
          ));
          this.spinner.start(event.aggressive ? 'Compacting (aggressive)' : 'Compacting');
          break;

        case 'compaction':
          this.spinner.stop();
          console.log(chalk.dim(
            `  ✓ Compacted ${event.oldMessages} messages → ${event.newMessages}` +
            (event.aggressive ? ' (aggressive pass)' : ''),
          ));
          this.spinner.start('Thinking');
          break;

        case 'error':
          this.spinner.stop();
          console.log(renderError(event.error.message));
          break;

        case 'turn-complete':
          this.spinner.stop();
          this.sessionTurns += event.turnsUsed;
          lastUsage = event.usage;
          if (event.turnsUsed > 0 || event.usage) {
            console.log(renderStatusLine({
              model: this.model,
              provider: this.provider.name,
              tokensUsed: event.usage?.totalTokens,
              contextWindow: capabilities.contextWindow,
              sessionTurns: this.sessionTurns,
              sessionToolCalls: this.sessionToolCalls,
              planMode: this.planMode,
            }));
          }
          if (event.stopReason === 'turn-limit') {
            console.log(chalk.yellow('  (stopped: maximum turns reached)'));
          } else if (event.stopReason === 'token-limit') {
            tokenLimitHaltThisRun = true;
          }
          break;
      }
    }

    if (toolCallsThisRun === 0 && lastUsage && lastUsage.completionTokens < 50) {
      this.consecutiveStuckTurns++;
      this.sessionLogger?.logStuckPattern(this.consecutiveStuckTurns);
    } else {
      this.consecutiveStuckTurns = 0;
    }

    if (tokenLimitHaltThisRun) {
      const replay = this.lastSubstantivePrompt ?? userInput;
      const used = this.tokenLimitReplayCounts.get(replay) ?? 0;
      if (used < 1) {
        this.tokenLimitReplayCounts.set(replay, used + 1);
        console.log(chalk.yellow(
          '  ⏵ Context window full — aggressively compacted; replaying prompt once.',
        ));
        process.stdout.write('\n');
        await this.runAgentLoop(replay);
        return;
      }
      console.log(chalk.red(
        '  ⚠ Compaction couldn\'t free enough context. Type /clear and rephrase.',
      ));
    }

    if (
      autoRetryExhaustedThisRun &&
      successfulToolCallsThisRun === 0 &&
      this.lastSubstantivePrompt
    ) {
      const replay = this.lastSubstantivePrompt;
      const used = this.replayCounts.get(replay) ?? 0;
      if (used < MAX_REPLAYS_PER_PROMPT) {
        this.replayCounts.set(replay, used + 1);
        console.log(chalk.red(
          `  ⚠ Auto-recovery: clearing conversation and replaying the last substantive prompt ` +
          `(attempt ${used + 1}/${MAX_REPLAYS_PER_PROMPT}).`,
        ));
        this.conversation.clear();
        this.consecutiveStuckTurns = 0;
        process.stdout.write('\n');
        await this.runAgentLoop(replay);
        return;
      }
      console.log(chalk.red(
        `  ⚠ Auto-recovery exhausted after ${MAX_REPLAYS_PER_PROMPT} replays — model couldn't make progress on this prompt. Giving up; please rephrase or take over manually.`,
      ));
    }

    if (this.planMode && this.plannedCalls.length > 0) {
      console.log(chalk.cyan.bold(
        `\n  Proposed plan: ${this.plannedCalls.length} change${this.plannedCalls.length === 1 ? '' : 's'}.`,
      ));
      console.log(chalk.dim('  Type ') + chalk.bold('y') + chalk.dim(' to approve, ') + chalk.bold('n') + chalk.dim(' to drop, or describe revisions.'));
    }

    process.stdout.write('\n');
  }

  private installEscListener(): () => void {
    if (!process.stdin.isTTY) return () => {};
    const wasRaw = process.stdin.isRaw ?? false;
    if (!wasRaw) process.stdin.setRawMode(true);
    readline.emitKeypressEvents(process.stdin);

    const handler = (_str: string, key: { name?: string; ctrl?: boolean } | undefined): void => {
      if (!key) return;
      if (key.name === 'escape') {
        console.log(chalk.yellow('\n  ⏸ Esc — aborting agent run.'));
        this.currentAbort?.abort();
        return;
      }
      if (key.ctrl && key.name === 'c') {
        process.kill(process.pid, 'SIGINT');
        return;
      }
      // Any other keypress while running means the user is typing. Stop the
      // spinner so the typed characters aren't overwritten by spinner ticks.
      if (this.state === 'running') {
        this.spinner.stop();
      }
    };
    process.stdin.on('keypress', handler);

    return () => {
      process.stdin.removeListener('keypress', handler);
      if (!wasRaw) process.stdin.setRawMode(false);
    };
  }

  private promptPermission(toolName: string): Promise<PermissionDecision> {
    const previousState = this.state;
    this.state = 'awaiting-permission';
    process.stdout.write(renderPermissionPrompt(toolName));
    const signal = this.currentAbort?.signal;
    return new Promise((resolve) => {
      const cleanup = (): void => {
        this.permissionResolver = undefined;
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        this.state = previousState;
        // Resolve so the REPL's for-await unblocks; the agent's own abort
        // handler has already short-circuited the tool execution.
        resolve('deny');
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.permissionResolver = (decision) => {
        cleanup();
        this.state = previousState;
        resolve(decision);
      };
    });
  }

  switchModel(model: string): void {
    this.model = model;
  }
}
