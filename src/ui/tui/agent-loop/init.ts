import type { MutableRefObject } from 'react';
import { Conversation } from '../../../core/context/conversation.js';
import { ContextManager } from '../../../core/context/context-manager.js';
import { makeCompactionResolver } from './compaction-resolver.js';
import { PermissionManager } from '../../../security/permissions.js';
import { FileCache } from '../../../core/agent/cache/file-cache.js';
import { loadSkills, SkillsRegistry } from '../../../core/skills/index.js';
import {
  createSessionLogger,
  loadHistoryFromSessions,
  type SessionLogger,
} from '../../../core/session/session-log.js';
import { instrumentProviderRequests } from '../../../providers/instrument.js';
import { logModelRequestFromInfo } from './instrument-bridge.js';
import { getBuildInfo } from '../../../utils/build-info.js';
import { errorMessage } from '../../../utils/errors.js';
import { buildEnvironmentMessage } from '../../../core/context/system-prompt.js';
import type { ExperimentalFlags } from '../../../core/config/types.js';
import type { NoticeLevel, RunRefs, UseAgentLoopOptions } from './agent-loop-types.js';

// Dedicated exit code for log failures so callers can distinguish from
// generic errors (1). Mirrors src/ui/headless.ts.
const STRICT_LOG_EXIT = 6;

export function startSessionLogger(
  opts: UseAgentLoopOptions,
  addNotice: (level: NoticeLevel, text: string) => void,
): SessionLogger | undefined {
  if (opts.enableSessionLog === false) return undefined;
  try {
    const sessionLogger = createSessionLogger({
      onWriteError: opts.strictLogging
        ? () => {
            // Stderr surface fired in session-log.ts; just escalate.
            process.exit(STRICT_LOG_EXIT);
          }
        : undefined,
    });
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
    const msg = errorMessage(err);
    addNotice('warn', `(session logging disabled: ${msg})`);
    if (opts.strictLogging) {
      process.stderr.write(`factory: session log unavailable — ${msg}\n`);
      process.exit(STRICT_LOG_EXIT);
    }
    return undefined;
  }
}

interface InitialRefsInput {
  opts: UseAgentLoopOptions;
  sessionLogger: SessionLogger | undefined;
  initialSystemPrompt: string;
  baseSystemPrompt: string;
  useTextToolFallback: boolean;
  initialPlanMode: boolean;
  initialExperimental: ExperimentalFlags;
  initialGitDirty: boolean | null;
  /** Live holder for the refs being built. The compaction-target
   *  resolver closes over this so it can read freshly-set fields
   *  (provider after a swap, the user-picked compactionTarget) without
   *  the construction-time snapshot going stale. */
  refsHolder: MutableRefObject<RunRefs | null>;
}

// eslint-disable-next-line complexity -- TODO(complexity): split optional-feature wiring (cache, hooks, planner) into builders.
export function createInitialRefs(input: InitialRefsInput): RunRefs {
  const { opts, sessionLogger, initialSystemPrompt } = input;
  const conversation = new Conversation(initialSystemPrompt, opts.agentConfig?.maxToolResultTokens);
  // Each tab snapshots process.cwd() at session start; subsequent tabs
  // inherit it, but each tab can diverge via `cd` in Bash or `/cwd`.
  const cwd = process.cwd();
  // Seed the conversation with environment facts as the first user message
  // (paired with a synthetic assistant ack to maintain user/assistant
  // alternation that Anthropic requires). The system prompt stays
  // byte-stable across turns this way — auto-cache providers hit from turn
  // 2 onward instead of paying full tokenization every time cwd or shell
  // would have shifted in the prefix.
  conversation.addUser(buildEnvironmentMessage(cwd));
  conversation.addAssistant('Got it.');
  const permissions = new PermissionManager();
  if (opts.autoAllowTools) {
    for (const t of opts.autoAllowTools) permissions.allowAll(t);
  }
  for (const host of opts.agentConfig?.web?.allowlist ?? []) {
    permissions.allowDomain(host);
  }
  if (opts.bashRules?.length) {
    permissions.setBashRules(opts.bashRules);
  }
  const capabilities = opts.provider.getCapabilities(opts.model);
  const contextManager = new ContextManager(
    conversation,
    capabilities,
    {
      compactionThreshold: opts.agentConfig?.compactionThreshold,
      recencyWindow: opts.agentConfig?.recencyWindow,
      recencyTokens: opts.agentConfig?.recencyTokens,
      toolResultAgingTurns: opts.agentConfig?.toolResultAgingTurns,
    },
    makeCompactionResolver(input.refsHolder),
  );

  const instrumentedProvider = sessionLogger
    ? instrumentProviderRequests(opts.provider, info => logModelRequestFromInfo(sessionLogger, info))
    : opts.provider;

  return {
    sessionLogger,
    conversation,
    permissions,
    contextManager,
    fileCache: new FileCache(),
    baseSystemPrompt: input.baseSystemPrompt,
    pastHistory: [],
    provider: instrumentedProvider,
    model: opts.model,
    primary: { provider: instrumentedProvider.name, model: opts.model },
    ...(opts.keyId ? { activeKeyId: opts.keyId } : {}),
    useTextToolFallback: input.useTextToolFallback,
    nativeToolSupport: opts.nativeToolSupport ?? true,
    planMode: input.initialPlanMode,
    enableCorrector: opts.enableCorrector ?? false,
    experimental: input.initialExperimental,
    ...(opts.agentConfig?.hooks ? { hooksConfig: opts.agentConfig.hooks } : {}),
    rotation: {
      keysEnabled: opts.agentConfig?.rotation?.keys ?? true,
      modelsEnabled: opts.agentConfig?.rotation?.models ?? true,
      default: opts.agentConfig?.rotation?.default
        ? opts.agentConfig.rotation.default.map(e => ({ ...e }))
        : [],
      overrides: opts.agentConfig?.rotation?.overrides
        ? Object.fromEntries(
            Object.entries(opts.agentConfig.rotation.overrides).map(([k, v]) => [
              k,
              v.map(e => ({ ...e })),
            ]),
          )
        : {},
    },
    keyFailureLog: new Map(),
    rotationPromptDeclined: false,
    ...(opts.compactionModel ? { compactionTarget: opts.compactionModel } : {}),
    gitBranch: opts.gitBranch,
    gitDirty: input.initialGitDirty,
    cwd,
    lastSubstantivePrompt: null,
    replayCounts: new Map(),
    tokenLimitReplayCounts: new Map(),
    inputQueue: [],
    historyIndex: -1,
    historyDraft: '',
    pathPolicy: opts.pathPolicy ?? {},
    envPolicy: opts.envPolicy ?? {},
  };
}

/**
 * Load skill files from disk when the experimental flag is on. Loader errors
 * for malformed files are reported via the session log + a UI notice but
 * never abort startup — a single broken skill must not brick the REPL.
 */
export async function initSkillsRegistry(
  cwd: string,
  enabled: boolean,
  sessionLogger: SessionLogger | undefined,
  addNotice: (level: NoticeLevel, text: string) => void,
): Promise<SkillsRegistry | undefined> {
  if (!enabled) return undefined;
  try {
    const { skills, warnings } = await loadSkills(cwd);
    for (const w of warnings) {
      sessionLogger?.logWarning('skills', w);
      addNotice('warn', `skill skipped: ${w}`);
    }
    if (skills.length > 0) {
      const alwaysOn = skills.filter(s => s.alwaysOn).length;
      addNotice(
        'info',
        `Loaded ${skills.length} skill${skills.length === 1 ? '' : 's'} (${alwaysOn} always-on).`,
      );
    }
    return new SkillsRegistry(skills);
  } catch (err) {
    addNotice('warn', `skills disabled: ${errorMessage(err)}`);
    return new SkillsRegistry([]);
  }
}

export async function loadInitialHistory(
  refs: { current: RunRefs | null },
  addNotice: (level: NoticeLevel, text: string) => void,
): Promise<void> {
  const h = await loadHistoryFromSessions();
  if (refs.current) refs.current.pastHistory = h;
  if (h.length > 0) {
    addNotice(
      'info',
      `Loaded ${h.length} prior input${h.length === 1 ? '' : 's'} (press up to recall).`,
    );
  }
}
