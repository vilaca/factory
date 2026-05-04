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
import type { AgentConfig } from '../core/config-types.js';
import { Conversation } from '../core/conversation.js';
import { ContextManager } from '../core/context-manager.js';
import { PermissionManager } from '../permissions.js';
import { runAgent } from '../core/agent.js';
import { FileCache } from '../core/agent/file-cache.js';
import { defaultRegistry } from '../tools/index.js';
import { createSessionLogger, type SessionLogger } from '../core/session-log.js';
import { getBuildInfo } from '../utils/build-info.js';

export interface HeadlessOptions {
  model: string;
  systemPrompt: string;
  provider: Provider;
  agentConfig?: AgentConfig;
  autoAllowTools?: string[];
  useTextToolFallback?: boolean;
  nativeToolSupport?: boolean;
  enableSessionLog?: boolean;
  planMode?: boolean;
  enableCorrector?: boolean;
  mcpInfo?: { servers: string[]; toolCount: number };
  gitBranch?: string;
  gitDirty?: boolean | null;
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

export async function runHeadless(options: HeadlessOptions): Promise<void> {
  const userInput = await readAllStdin();
  if (!userInput) {
    process.stderr.write('factory: no input on stdin\n');
    process.exit(2);
  }

  let sessionLogger: SessionLogger | undefined;
  if (options.enableSessionLog !== false) {
    try {
      sessionLogger = createSessionLogger();
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
    } catch {
      // Logging failures must never break headless runs.
    }
  }

  const conversation = new Conversation(options.systemPrompt);
  const permissions = new PermissionManager();
  for (const toolName of options.autoAllowTools ?? []) {
    permissions.allowAll(toolName);
  }

  const capabilities = options.provider.getCapabilities(options.model);
  const contextManager = new ContextManager(conversation, capabilities, {
    compactionThreshold: options.agentConfig?.compactionThreshold,
    recencyWindow: options.agentConfig?.recencyWindow,
  });

  let exitCode = 0;
  let permissionDeniedTool: string | undefined;

  try {
    for await (const event of runAgent(userInput, {
      provider: options.provider,
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
      },
      fileCache: new FileCache(),
    })) {
      sessionLogger?.logAgentEvent(event);

      switch (event.type) {
        case 'text-chunk':
          process.stdout.write(event.content);
          break;
        case 'tool-call-start':
          process.stderr.write(`▶ ${event.toolName} ${formatArgsBrief(event.args)}\n`);
          break;
        case 'tool-call-result':
          process.stderr.write(`  ${event.result.success ? '✓' : '✗'} ${event.toolName}\n`);
          break;
        case 'tool-call-denied':
          process.stderr.write(`  (denied: ${event.toolName})\n`);
          break;
        case 'permission-request':
          // Non-TTY: nobody to answer. Deny and surface a clear pointer.
          permissionDeniedTool = event.toolName;
          event.respond('deny');
          break;
        case 'error':
          process.stderr.write(`factory: ${event.error.message}\n`);
          exitCode = 1;
          break;
        case 'turn-complete':
          if (event.stopReason === 'error') exitCode = exitCode || 1;
          else if (event.stopReason === 'token-limit') exitCode = exitCode || 5;
          break;
      }
    }
  } finally {
    process.stdout.write('\n');
    if (permissionDeniedTool && exitCode === 0) {
      process.stderr.write(
        `factory: tool '${permissionDeniedTool}' requires permission but stdin is not a TTY. ` +
        `Add '${permissionDeniedTool}' to permissions.allowAll in ~/.factory/config.json to allow it in headless mode.\n`,
      );
      exitCode = 3;
    }
    sessionLogger?.logSessionEnd();
    sessionLogger?.close();
  }

  process.exit(exitCode);
}
