import { Conversation } from '../../../core/conversation.js';
import { ContextManager } from '../../../core/context-manager.js';
import { PermissionManager } from '../../../permissions.js';
import { FileCache } from '../../../core/agent/file-cache.js';
import {
  createSessionLogger,
  loadHistoryFromSessions,
  type SessionLogger,
} from '../../../core/session-log.js';
import { getBuildInfo } from '../../../utils/build-info.js';
import type { ExperimentalFlags } from '../../../core/config-types.js';
import type { NoticeLevel, RunRefs, UseAgentLoopOptions } from './types.js';

export function startSessionLogger(
  opts: UseAgentLoopOptions,
  addNotice: (level: NoticeLevel, text: string) => void,
): SessionLogger | undefined {
  if (opts.enableSessionLog === false) return undefined;
  try {
    const sessionLogger = createSessionLogger();
    const build = getBuildInfo();
    sessionLogger.logSessionStart({
      model: opts.model,
      provider: opts.provider.name,
      cwd: process.cwd(),
      experimental: opts.agentConfig?.experimental as Record<string, boolean> | undefined,
      turnTimeoutSec: opts.agentConfig?.turnTimeoutSec,
      appVersion: build.version,
      buildTimestamp: build.buildTimestamp,
      mcp: opts.mcpInfo,
      gitBranch: opts.gitBranch,
      gitDirty: opts.gitDirty,
    });
    return sessionLogger;
  } catch (err) {
    addNotice('warn', `(session logging disabled: ${(err as Error).message})`);
    return undefined;
  }
}

export interface InitialRefsInput {
  opts: UseAgentLoopOptions;
  sessionLogger: SessionLogger | undefined;
  initialSystemPrompt: string;
  baseSystemPrompt: string;
  useTextToolFallback: boolean;
  initialPlanMode: boolean;
  initialExperimental: ExperimentalFlags;
  initialGitDirty: boolean | null;
}

export function createInitialRefs(input: InitialRefsInput): RunRefs {
  const { opts, sessionLogger, initialSystemPrompt } = input;
  const conversation = new Conversation(initialSystemPrompt);
  const permissions = new PermissionManager();
  if (opts.autoAllowTools) {
    for (const t of opts.autoAllowTools) permissions.allowAll(t);
  }
  const capabilities = opts.provider.getCapabilities(opts.model);
  const contextManager = new ContextManager(conversation, capabilities, {
    compactionThreshold: opts.agentConfig?.compactionThreshold,
    recencyWindow: opts.agentConfig?.recencyWindow,
  });

  return {
    sessionLogger,
    conversation,
    permissions,
    contextManager,
    fileCache: new FileCache(),
    baseSystemPrompt: input.baseSystemPrompt,
    pastHistory: [],
    provider: opts.provider,
    model: opts.model,
    useTextToolFallback: input.useTextToolFallback,
    nativeToolSupport: opts.nativeToolSupport ?? true,
    planMode: input.initialPlanMode,
    enableCorrector: opts.enableCorrector ?? true,
    experimental: input.initialExperimental,
    gitBranch: opts.gitBranch,
    gitDirty: input.initialGitDirty,
    // Each tab snapshots process.cwd() at session start; subsequent tabs
    // inherit it, but each tab can diverge via `cd` in Bash or `/cwd`.
    cwd: process.cwd(),
    lastSubstantivePrompt: null,
    replayCounts: new Map(),
    tokenLimitReplayCounts: new Map(),
    inputQueue: [],
    historyIndex: -1,
    historyDraft: '',
  };
}

export async function loadInitialHistory(
  refs: { current: RunRefs | null },
  addNotice: (level: NoticeLevel, text: string) => void,
): Promise<void> {
  const h = await loadHistoryFromSessions();
  if (refs.current) refs.current.pastHistory = h;
  if (h.length > 0) {
    addNotice('info', `Loaded ${h.length} prior input${h.length === 1 ? '' : 's'} (press up to recall).`);
  }
}
