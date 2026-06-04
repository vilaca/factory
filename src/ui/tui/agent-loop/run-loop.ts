import path from 'path';
import { runAgent } from '../../../core/agent/run-agent.js';
import type { AgentOptions, RotationOptions } from '../../../core/agent/types.js';
import { createProvider } from '../../../providers/registry.js';
import { prime } from '../../../providers/prime.js';
import { descriptorByAlias } from '../../../providers/registry.js';
import { instrumentProviderRequests } from '../../../providers/instrument.js';
import { logModelRequestTo } from '../../session-bridge.js';
import type { Provider } from '../../../providers/types.js';
import type { SessionLogger } from '../../../core/session/session-log.js';
import { loadGlobalConfig } from '../../../core/config/index.js';
import { tupleKey } from '../../../core/config/types.js';
import { listKeys } from '../../../core/auth/credentials.js';
import { getWarmthLog } from '../../../core/session/key-stats.js';
import { handleAgentEvent } from './event-handler.js';
import type { AgentLoopDeps } from './agent-loop-types.js';
import {
  createDiagnosticEmitter,
  sessionLogDiagnosticSink,
  tuiDiagnosticSink,
} from '../../diagnostics.js';
import { refreshScopedProjectInstructionsFromToolCall } from '../../../core/context/scoped-project-instructions.js';

/** Anthropic's default ephemeral cache TTL. The rotation tiebreaker uses
 *  the same window so a key that hit cache "recently" by Anthropic's
 *  standard is also "warm" by ours. */
const ROTATION_CACHE_WARMTH_TTL_MS = 5 * 60 * 1000;

const TRIVIAL_PROMPTS = new Set([
  'ok',
  'okay',
  'yes',
  'no',
  'y',
  'n',
  'go',
  'go on',
  'do it',
  'do the call',
  'do the calls',
  'continue',
  'next',
  'sure',
]);
const MAX_REPLAYS_PER_PROMPT = 2;

function isSubstantivePrompt(s: string): boolean {
  if (s.length >= 25) return true;
  return !TRIVIAL_PROMPTS.has(s.toLowerCase());
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

/**
 * Build the per-turn rotation context. Returns undefined when:
 *  - rotation is disabled (`agent.rotation.keys === false`),
 *  - the active provider has no descriptor (off-the-rails state),
 *  - or the provider has fewer than two saved keys (nothing to rotate to).
 *
 * Reads the live config so newly-added keys (via /model mid-session) take
 * effect on the next turn without a restart.
 */
/**
 * Wrap a rotation-spawned provider with the session-log instrumentation so
 * mid-stream rotation (tier-1 key swap, tier-2 tuple advance) doesn't drop
 * `model-request` rows. Returns the provider untouched when no session
 * logger is attached. Exported so the unit test can assert that
 * `withKey` / `withTuple` actually wrap their results.
 */
export function makeRotationWrap(logger: SessionLogger | undefined): (p: Provider) => Provider {
  if (!logger) return p => p;
  return p => instrumentProviderRequests(p, info => logModelRequestTo(logger, info));
}

async function buildRotationOptions(deps: AgentLoopDeps): Promise<RotationOptions | undefined> {
  const refs = deps.refs.current;
  if (!refs) return undefined;
  // The rotation context is built when *either* tier is enabled.
  // callModel decides per-call whether a given tier fires.
  const keysEnabled = refs.rotation.keysEnabled;
  const modelsEnabled = refs.rotation.modelsEnabled;
  if (!keysEnabled && !modelsEnabled) return undefined;

  const descriptor = descriptorByAlias(refs.provider.name);
  if (!descriptor) return undefined;
  let cfg;
  try {
    cfg = await loadGlobalConfig();
  } catch {
    return undefined;
  }
  const keys = listKeys(cfg, descriptor.name);

  // Resolve the chain for the active tuple: per-(provider, model) override
  // beats the default. Empty when neither is set.
  const key = tupleKey({ provider: refs.provider.name, model: refs.model });
  const chain = refs.rotation.overrides[key] ?? refs.rotation.default;

  // Skip context build entirely when neither tier has any work to do AND
  // there's no requestFallback bridge to ask the user. With the bridge,
  // even an unconfigured provider gets the "set one up?" prompt.
  const tier1Possible = keysEnabled && keys.length >= 2;
  const tier2Possible = modelsEnabled && chain.length > 0;
  const promptPossible = Boolean(refs.requestFallback) && modelsEnabled;
  if (!tier1Possible && !tier2Possible && !promptPossible) return undefined;

  const wrap = makeRotationWrap(refs.sessionLogger);
  return {
    keys,
    activeKeyId: refs.activeKeyId,
    withKey: async key => {
      const unprimed = createProvider(refs.provider.name, {
        token: key.token,
        ...(descriptor.needsAccountId && key.extras?.accountId
          ? { accountId: key.extras.accountId }
          : {}),
      });
      // Prime the rotated provider — it will be consumed by
      // chat()/chatNoStream() and (via onProviderChange) become the
      // next turn's RunRefs.provider, so the cf880ed contract applies.
      const { provider } = await prime(unprimed);
      return wrap(provider);
    },
    onActiveKeyChange: id => {
      if (!deps.refs.current) return;
      deps.refs.current.activeKeyId = id;
      // Stored response chain is keyed server-side by API key; a rotated
      // key can't continue the prior chain.
      deps.refs.current.responsesChain = undefined;
    },
    onProviderChange: next => {
      if (deps.refs.current) deps.refs.current.provider = next;
    },
    onModelChange: m => {
      if (deps.refs.current) deps.refs.current.model = m;
    },
    failureLog: refs.keyFailureLog,
    getWarmthLog: () => getWarmthLog(refs.provider.name, ROTATION_CACHE_WARMTH_TTL_MS),
    modelsEnabled,
    chain,
    loadKeysForProvider: async providerName => {
      const desc = descriptorByAlias(providerName);
      if (!desc) return [];
      const c = await loadGlobalConfig();
      return listKeys(c, desc.name);
    },
    withTuple: async (providerName, key) => {
      const desc = descriptorByAlias(providerName);
      const opts: Parameters<typeof createProvider>[1] = { token: key.token };
      if (desc?.needsAccountId && key.extras?.accountId) {
        opts.accountId = key.extras.accountId;
      }
      const unprimed = createProvider(providerName, opts);
      const { provider } = await prime(unprimed);
      return wrap(provider);
    },
    ...(refs.requestFallback ? { promptForFallback: refs.requestFallback } : {}),
  };
}

// eslint-disable-next-line complexity -- TODO(complexity): split pre-turn refresh/rotation setup from event pump.
export async function runAgentLoopInternal(userInput: string, deps: AgentLoopDeps): Promise<void> {
  if (!deps.refs.current) return;
  const projectRoot = deps.refs.current.projectRoot;
  deps.refs.current.abort = new AbortController();
  deps.setThinking(true);

  let successfulToolCallsThisRun = 0;
  let autoRetryExhaustedThisRun = false;
  let tokenLimitHaltThisRun = false;

  let assistantBuffer = '';

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutSec = deps.agentConfig?.turnTimeoutSec;
  if (timeoutSec) {
    timeoutHandle = setTimeout(() => {
      deps.addNotice('warn', `⏱ Turn timeout (${timeoutSec}s) — aborting.`);
      deps.refs.current?.abort?.abort();
    }, timeoutSec * 1000);
  }

  // Pass a mutable holder so Bash's `cwdAfter` flows back into refs.cwd in
  // real time (subsequent tools in the same turn see the new directory).
  const cwdRef = { current: deps.refs.current.cwd };

  // Adapter into RunRefs.responsesChain so chain state survives between
  // runAgent invocations. The runtime reads it pre-call and writes it
  // post-call; reset hooks live on /clear, swap, and inside runAgent itself.
  const responsesChainRef: AgentOptions['responsesChainRef'] = {
    get: () => deps.refs.current?.responsesChain,
    set: v => {
      if (deps.refs.current) deps.refs.current.responsesChain = v;
    },
  };

  // Build the rotation context for this turn. Loading global config here is
  // a few-ms fs read and lets the runtime see the latest saved keys (the
  // user may have added one via /model mid-session).
  const rotation = await buildRotationOptions(deps);

  const hookDiagnostics = createDiagnosticEmitter(
    sessionLogDiagnosticSink(() => deps.refs.current?.sessionLogger),
  );

  const refreshScopedInstructions = async (info: {
    toolName: string;
    args: Record<string, unknown>;
    cwd: string;
  }): Promise<{ changed: boolean; newFiles: string[] } | null> => {
    if (!deps.refs.current) return null;
    const refs = deps.refs.current;
    const scopedState = {
      projectRoot: refs.projectRoot,
      touchedDirs: refs.instructionTouchedDirs,
      scopedInstructions: refs.scopedProjectInstructions,
      loadedFiles: refs.scopedInstructionFiles,
      virtualRootDirs: refs.instructionVirtualRootDirs,
    };
    const refresh = await refreshScopedProjectInstructionsFromToolCall(
      scopedState,
      { toolName: info.toolName, args: info.args },
      info.cwd,
    );
    refs.scopedProjectInstructions = scopedState.scopedInstructions;
    refs.scopedInstructionFiles = scopedState.loadedFiles;
    if (refresh.changed) {
      refs.conversation.updateSystemPrompt(deps.composeSystemPrompt());
      deps.refreshTokenEstimate();
    }
    return refresh;
  };

  const preTurnRefresh = await refreshScopedInstructions({
    toolName: 'TurnStart',
    args: {},
    cwd: cwdRef.current,
  });
  if (preTurnRefresh?.changed) {
    const diagnostics = createDiagnosticEmitter(
      tuiDiagnosticSink((level, text) => deps.addNotice(level, text)),
      sessionLogDiagnosticSink(() => deps.refs.current?.sessionLogger),
    );
    const count = preTurnRefresh.newFiles.length;
    const names = formatScopedInstructionFiles(preTurnRefresh.newFiles, projectRoot);
    diagnostics.info(
      count > 0
        ? `Loaded scoped project instructions from ${count} file${count === 1 ? '' : 's'}: ${names}`
        : 'Loaded additional scoped project instructions.',
      'project-instructions-scoped',
    );
  }

  const agent = runAgent(userInput, {
    provider: deps.refs.current.provider,
    model: deps.refs.current.model,
    conversation: deps.refs.current.conversation,
    permissions: deps.refs.current.permissions,
    toolRegistry: deps.refs.current.toolRegistry,
    useTextToolFallback: deps.refs.current.useTextToolFallback,
    nativeToolSupport: deps.refs.current.nativeToolSupport,
    planMode: deps.refs.current.planMode,
    enableCorrector: deps.refs.current.enableCorrector,
    contextManager: deps.refs.current.contextManager,
    experimental: {
      bashDedup: deps.refs.current.experimental.bashDedup,
      readCache: deps.refs.current.experimental.readCache,
      hooks: deps.refs.current.experimental.hooks,
    },
    fileCache: deps.refs.current.fileCache,
    signal: deps.refs.current.abort.signal,
    cwdRef,
    // Snapshot the policy from the per-tab RunRefs so tools see the same
    // deny lists per-tab (rather than a process-global singleton). The
    // policies were threaded in from index.ts at session start.
    pathPolicy: deps.refs.current.pathPolicy,
    envPolicy: deps.refs.current.envPolicy,
    hooksConfig: deps.agentConfig?.hooks,
    onHookStderr: (command, chunk) =>
      hookDiagnostics.warning(`${command}: ${chunk.trim()}`, 'hook-stderr'),
    onHookError: (event, error) => hookDiagnostics.warning(`${event}: ${error}`, 'hook-error'),
    responsesChainRef,
    onToolCallStart: refreshScopedInstructions,
    onSuccessfulToolCall: refreshScopedInstructions,
    ...(rotation ? { rotation } : {}),
  });

  for await (const event of agent) {
    if (event.type !== 'text-chunk') {
      deps.refs.current.sessionLogger?.logAgentEvent(event);
    }
    handleAgentEvent(event, deps, {
      getStreamingBuffer: () => assistantBuffer,
      setStreamingBuffer: s => {
        assistantBuffer = s;
      },
      addSuccessfulToolCall: () => successfulToolCallsThisRun++,
      markAutoRetryExhausted: () => {
        autoRetryExhaustedThisRun = true;
      },
      markTokenLimitHalt: () => {
        tokenLimitHaltThisRun = true;
      },
    });
  }

  // Persist any cwd change Bash made during this turn back into refs so the
  // next turn (and the StatusBar) sees it. Surface the change so the user
  // understands subsequent tool calls operate in the new directory.
  if (deps.refs.current && cwdRef.current !== deps.refs.current.cwd) {
    deps.addNotice('info', `📁 cwd → ${cwdRef.current}`);
    deps.refs.current.cwd = cwdRef.current;
  }

  if (tokenLimitHaltThisRun) {
    const replay = deps.refs.current.lastSubstantivePrompt ?? userInput;
    const used = deps.refs.current.tokenLimitReplayCounts.get(replay) ?? 0;
    if (used < 1) {
      deps.refs.current.tokenLimitReplayCounts.set(replay, used + 1);
      deps.addNotice(
        'warn',
        '⏵ Context window full — aggressively compacted; replaying prompt once.',
      );
      await runAgentLoopInternal(replay, deps);
      return;
    }
    deps.addNotice('danger', "⚠ Compaction couldn't free enough context. Use /clear and rephrase.");
  }

  // Auto-recovery: clear+replay if no successful tool call this run.
  if (
    autoRetryExhaustedThisRun &&
    successfulToolCallsThisRun === 0 &&
    deps.refs.current.lastSubstantivePrompt
  ) {
    const replay = deps.refs.current.lastSubstantivePrompt;
    const used = deps.refs.current.replayCounts.get(replay) ?? 0;
    if (used < MAX_REPLAYS_PER_PROMPT) {
      deps.refs.current.replayCounts.set(replay, used + 1);
      deps.addNotice(
        'danger',
        `⚠ Auto-recovery: clearing conversation and replaying the last substantive prompt (attempt ${used + 1}/${MAX_REPLAYS_PER_PROMPT}).`,
      );
      deps.refs.current.conversation.clear();
      await runAgentLoopInternal(replay, deps);
      return;
    }
    deps.addNotice(
      'danger',
      `⚠ Auto-recovery exhausted after ${MAX_REPLAYS_PER_PROMPT} replays — model couldn't make progress on this prompt. Giving up; please rephrase or take over manually.`,
    );
  }

  if (deps.refs.current.planMode && deps.getPlannedCalls().length > 0) {
    const count = deps.getPlannedCalls().length;
    deps.addNotice('cyan', `Proposed plan: ${count} change${count === 1 ? '' : 's'}.`);
    deps.addNotice('info', 'Type y to approve, n to drop, or describe revisions.');
  }

  if (timeoutHandle) clearTimeout(timeoutHandle);
  deps.refs.current.abort = undefined;
  deps.setThinking(false);
  deps.setRunningTool(null);
  deps.setCompacting(null);
}

export async function processInput(trimmed: string, deps: AgentLoopDeps): Promise<void> {
  if (!deps.refs.current) return;

  deps.refs.current.sessionLogger?.logUserInput(trimmed);
  deps.addItem({ kind: 'user-input', id: deps.nextId(), text: trimmed });

  if (isSubstantivePrompt(trimmed)) {
    deps.refs.current.lastSubstantivePrompt = trimmed;
  }

  // Evaluate conditional skills against the new prompt and inject any
  // matched bodies as a single synthetic system message. Goes in *before*
  // the user prompt so the model sees the skill context first.
  const skills = deps.refs.current.skills;
  if (skills) {
    const matches = skills.evaluate(trimmed);
    const text = skills.formatInjection(matches);
    if (text) {
      deps.refs.current.conversation.addUser(`[System: ${text}]`);
      const skillDiagnostics = createDiagnosticEmitter(
        sessionLogDiagnosticSink(() => deps.refs.current?.sessionLogger),
      );
      skillDiagnostics.warning(`injected: ${matches.map(m => m.skill.name).join(', ')}`, 'skills');
    }
  }

  deps.setState('running');
  await runAgentLoopInternal(trimmed, deps);
}
