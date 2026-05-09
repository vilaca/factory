// Mount-time setup for useAgentLoop. The hook itself owns the React state
// declarations (rules of hooks); this file owns the imperative wiring of
// session logger, refs, skills, hook fires, and the symmetric SessionEnd
// teardown — all of which used to live inline in a 150-line useEffect.

import type { MutableRefObject } from 'react';
import type { ExperimentalFlags } from '../../../core/config-types.js';
import { runHook } from '../../../core/hooks/index.js';
import { composeSystemPrompt as composeSystemPromptPure } from './system-prompt.js';
import {
  createInitialRefs,
  initSkillsRegistry,
  loadInitialHistory,
  startSessionLogger,
} from './init.js';
import type { NoticeLevel, RunRefs, UseAgentLoopOptions } from './types.js';

export interface MountContext {
  refs: MutableRefObject<RunRefs | null>;
  addNotice: (level: NoticeLevel, text: string) => void;
  setEstimatedTokens: (n: number | undefined) => void;
  setCwdState: (s: string) => void;
  /** Snapshot the current refs into a system prompt. The hook owns this
   *  closure because it threads through the experimental-flags state. */
  composeSystemPrompt: () => string;
}

/** Run a SessionStart hook fire-and-forget, surfacing fired/error notices
 *  to the UI and injecting any additionalContext as a user message. */
function fireSessionStartHook(opts: UseAgentLoopOptions, ctx: MountContext): void {
  const cwd = process.cwd();
  const sessionLogger = ctx.refs.current?.sessionLogger;
  void runHook(
    'SessionStart',
    { provider: opts.provider.name, model: opts.model, cwd },
    {
      cwd,
      config: opts.agentConfig?.hooks,
      envPolicy: opts.envPolicy,
      onStderr: (command, chunk) =>
        sessionLogger?.logWarning('hook-stderr', `${command}: ${chunk.trim()}`),
    },
  )
    .then(r => {
      for (const e of r.errors) {
        ctx.addNotice('warn', `⚠ SessionStart hook: ${e}`);
        sessionLogger?.logWarning('hook-error', `SessionStart: ${e}`);
      }
      for (const hookCommand of r.firedCommands) {
        const exe = hookCommand.split(/\s+/)[0] ?? hookCommand;
        const name = exe.split('/').pop() ?? exe;
        const suffix = r.notice ? ` — ${r.notice}` : '';
        ctx.addNotice('info', `↪ SessionStart hook ran (${name})${suffix}`);
        sessionLogger?.logWarning(
          'hook-fired',
          `SessionStart: ${hookCommand}${r.notice ? ` (${r.notice})` : ''}`,
        );
      }
      // Inject SessionStart additionalContext as a user message so the
      // model picks it up on the next turn. Hook fire is async; if the
      // user types fast the first turn won't include it (acceptable).
      if (r.additionalContext) {
        ctx.refs.current?.conversation.addUser(r.additionalContext);
      }
    })
    .catch(err => {
      const msg = err?.message ?? String(err);
      ctx.addNotice('warn', `⚠ SessionStart hook: ${msg}`);
      sessionLogger?.logWarning('hook-error', `SessionStart: ${msg}`);
    });
}

/** Symmetric SessionEnd hook fire on tab teardown. UI is going away by
 *  the time this runs, so notices are skipped — only the session log
 *  survives. */
function fireSessionEndHook(opts: UseAgentLoopOptions, ctx: MountContext): void {
  const cwd = process.cwd();
  const sessionLogger = ctx.refs.current?.sessionLogger;
  void runHook(
    'SessionEnd',
    { provider: opts.provider.name, model: opts.model, cwd },
    {
      cwd,
      config: opts.agentConfig?.hooks,
      envPolicy: opts.envPolicy,
      onStderr: (command, chunk) =>
        sessionLogger?.logWarning('hook-stderr', `${command}: ${chunk.trim()}`),
    },
  )
    .then(r => {
      for (const e of r.errors) sessionLogger?.logWarning('hook-error', `SessionEnd: ${e}`);
      for (const hookCommand of r.firedCommands) {
        sessionLogger?.logWarning(
          'hook-fired',
          `SessionEnd: ${hookCommand}${r.notice ? ` (${r.notice})` : ''}`,
        );
      }
    })
    .catch(() => {
      /* never block teardown */
    });
}

/**
 * One-shot session mount: build refs, start the session logger, queue
 * skills initialization, fire SessionStart, seed token estimate. Returns
 * the matching cleanup function (signal abort, fire SessionEnd, close
 * logger) for the host's useEffect to register.
 */
export function mountSession(opts: UseAgentLoopOptions, ctx: MountContext): () => void {
  const sessionLogger = startSessionLogger(opts, ctx.addNotice);

  const baseSystemPrompt = opts.systemPrompt;
  const useTextToolFallback = opts.useTextToolFallback ?? false;
  const initialPlanMode = opts.planMode ?? false;
  const initialExperimental: ExperimentalFlags = { ...(opts.agentConfig?.experimental ?? {}) };
  const initialGitDirty = opts.gitDirty ?? null;

  const initialSystemPrompt = composeSystemPromptPure({
    baseSystemPrompt,
    useTextToolFallback,
    planMode: initialPlanMode,
    lineCountHint: initialExperimental.lineCountHint ?? false,
    subagents: initialExperimental.subagents ?? false,
    gitDirty: initialGitDirty,
  });

  ctx.refs.current = createInitialRefs({
    opts,
    sessionLogger,
    initialSystemPrompt,
    baseSystemPrompt,
    useTextToolFallback,
    initialPlanMode,
    initialExperimental,
    initialGitDirty,
  });

  // Skills load asynchronously; once loaded, attach the registry and rebuild
  // the system prompt so any alwaysOn skills are picked up before the first
  // turn. Conditional skills don't need a prompt rebuild — they're injected
  // per-turn from processInput.
  void initSkillsRegistry(
    process.cwd(),
    initialExperimental.skills ?? true,
    sessionLogger,
    ctx.addNotice,
  ).then(reg => {
    if (!ctx.refs.current || !reg) return;
    ctx.refs.current.skills = reg;
    if (reg.alwaysOnSection().length > 0) {
      const sp = ctx.composeSystemPrompt();
      ctx.refs.current.conversation.updateSystemPrompt(sp);
      sessionLogger?.logSystemPromptChange('skills-loaded');
      sessionLogger?.logSystemPrompt(sp);
    }
  });

  // Seed the token estimate so the status bar shows the system prompt's
  // baseline before the first model response.
  ctx.refs.current.contextManager.updateUsage(undefined);
  ctx.setEstimatedTokens(ctx.refs.current.contextManager.getTokenEstimate());

  // Sync cwd state with the freshly-seeded refs.cwd (createInitialRefs uses
  // process.cwd() at creation time; useState's lazy init may have captured a
  // different value if process.cwd() shifted in between).
  ctx.setCwdState(ctx.refs.current.cwd);

  if (sessionLogger) {
    sessionLogger.logSystemPrompt(initialSystemPrompt);
    ctx.addNotice('info', `Session log: ${sessionLogger.filePath}`);
  }

  if (opts.validationWarning) {
    ctx.addNotice('warn', `⚠ ${opts.validationWarning}`);
  }

  void loadInitialHistory(ctx.refs, ctx.addNotice);

  if (initialExperimental.hooks) {
    fireSessionStartHook(opts, ctx);
  }

  return () => {
    // Closing a tab while its agent is still running: signal abort so the
    // run-loop unwinds promptly instead of writing to React state on the
    // unmounted Session and continuing to spawn tools.
    ctx.refs.current?.abort?.abort();
    if (ctx.refs.current?.experimental.hooks) {
      fireSessionEndHook(opts, ctx);
    }
    sessionLogger?.logSessionEnd();
    sessionLogger?.close();
  };
}
