import type { AgentEvent } from '../../../core/agent/types.js';
import type { AgentLoopDeps } from './agent-loop-types.js';
import {
  recordFailure as recordKeyFailure,
  recordSuccess as recordKeySuccess,
  recordTokenUsage as recordKeyTokenUsage,
} from '../../../core/session/key-stats.js';

interface StreamingState {
  getStreamingBuffer: () => string;
  setStreamingBuffer: (s: string) => void;
  addSuccessfulToolCall: () => void;
  markAutoRetryExhausted: () => void;
  markTokenLimitHalt: () => void;
}

/** A handler narrowed to a single AgentEvent variant via the discriminator. */
type HandlerFor<T extends AgentEvent['type']> = (
  event: Extract<AgentEvent, { type: T }>,
  deps: AgentLoopDeps,
  ss: StreamingState,
) => void;

type EventHandlers = {
  [K in AgentEvent['type']]?: HandlerFor<K>;
};

function describeRecoverySource(source: string): string {
  if (source === 'bare') return 'bare JSON';
  if (source === 'fence') return 'a JSON code block';
  if (source === 'shell-fence') return 'a shell code block';
  return 'tagged JSON';
}

function describeRotationReason(reason: string): string {
  return reason === 'rate-limit' ? 'rate-limited' : 'auth failed';
}

function fingerprintLabel(entry: { label?: string; fingerprint: string }): string {
  return entry.label ? `${entry.label} · …${entry.fingerprint}` : `…${entry.fingerprint}`;
}

const HANDLERS: EventHandlers = {
  'text-chunk': (event, deps, ss) => {
    deps.setThinking(false);
    // First chunk after a retry/rotation activity proves the call is
    // making forward progress — clear the activity label so the status
    // bar returns to plain "running".
    deps.setActivity(null);
    const next = ss.getStreamingBuffer() + event.content;
    ss.setStreamingBuffer(next);
    deps.setStreamingText(next);
  },

  'text-done': (event, deps, ss) => {
    // Commit the finalized text to items[] (which feeds <Static>) and clear
    // the streaming buffer. <Static> keeps history in the terminal's real
    // scrollback; only the streaming buffer + spinner re-render.
    if (event.fullContent) {
      deps.addItem({
        kind: 'assistant-text',
        id: deps.nextId(),
        text: event.fullContent,
        streaming: false,
      });
    }
    ss.setStreamingBuffer('');
    deps.setStreamingText('');
    deps.setThinking(true);
    deps.refreshTokenEstimate();
  },

  'tool-call-start': (event, deps) => {
    deps.setThinking(false);
    deps.setRunningTool(event.toolName);
    // Hold the call in the dynamic region instead of committing it to <Static>
    // immediately. We don't yet know whether it's going to resolve as ok/denied,
    // and Static can't re-render past items.
    deps.setPendingToolCall({ toolName: event.toolName, args: event.args });
  },

  'tool-call-result': (event, deps, ss) => {
    deps.setPendingToolCall(null);
    deps.addItem({
      kind: 'tool-call',
      id: deps.nextId(),
      toolName: event.toolName,
      args: event.args,
      status: 'ok',
    });
    // The toolPreview gate hides the verbose body of *successful* tool results
    // (the noise case the flag exists to silence). Failures, empty-success, and
    // tools that flag the body as `important` still render — those carry the only
    // signal that something went sideways, and the model already sees them.
    // `important` is how Bash surfaces a non-zero exit (which keeps success=true
    // so auto-retry doesn't fire on every failing test, but still needs to reach
    // the user).
    const isNoise = event.result.success && !event.result.empty && !event.result.important;
    if (!isNoise || deps.refs.current?.experimental?.toolPreview) {
      const preview = event.result.displayOutput ?? event.result.output;
      // Only attach the full version when it actually differs from the preview,
      // so the /full toggle has nothing to expand on tools that already show
      // their entire output (Bash, Glob, Grep).
      const full = event.result.output !== preview ? event.result.output : undefined;
      deps.addItem({
        kind: 'tool-result',
        id: deps.nextId(),
        toolName: event.toolName,
        output: preview,
        outputFull: full,
        success: event.result.success,
        empty: event.result.empty,
      });
    }
    if (event.result.success) ss.addSuccessfulToolCall();
    deps.setSessionToolCalls(n => n + 1);
    // Skill matcher uses recent tool names to gate `tools:` constrained
    // skills — track the call before the next user prompt evaluates.
    deps.refs.current?.skills?.recordToolUsed(event.toolName);
    deps.setRunningTool(null);
    deps.setThinking(true);
    // Tool results add (often large) chunks to the conversation.
    deps.refreshTokenEstimate();
  },

  'tool-call-denied': (event, deps) => {
    deps.setPendingToolCall(null);
    deps.addItem({
      kind: 'tool-call',
      id: deps.nextId(),
      toolName: event.toolName,
      args: event.args,
      status: 'denied',
    });
    deps.setRunningTool(null);
  },

  'tool-call-recovered': (event, deps) => {
    const refs = deps.refs.current!;
    if (refs.useTextToolFallback) return;
    const sourceLabel = describeRecoverySource(event.source);
    deps.addNotice(
      'warn',
      `⚠ Model emitted tool call as ${sourceLabel} instead of structured tool_calls. Recovered ${event.count} call${event.count === 1 ? '' : 's'} via fallback parser.`,
    );
    refs.useTextToolFallback = true;
    refs.conversation.updateSystemPrompt(deps.composeSystemPrompt());
    refs.sessionLogger?.logSystemPromptChange('text-tool-fallback=true (auto)');
    deps.addNotice(
      'warn',
      '⚠ Auto-enabling text-tool fallback mode — model will be instructed to use <tool_call> format from now on. Subsequent recoveries will be silent.',
    );
  },

  'tool-result-imitation-stripped': (event, deps) =>
    deps.addNotice(
      'danger',
      `⚠ Model fabricated ${event.count} tool result block${event.count === 1 ? '' : 's'} in its response. Stripped before storing — the result was NOT real.`,
    ),

  'auto-retry-injected': (event, deps) =>
    deps.addNotice(
      'warn',
      `↻ Model bailed after a tool failure — auto-injecting retry nudge (${event.remainingBudget} retr${event.remainingBudget === 1 ? 'y' : 'ies'} left).`,
    ),

  'auto-retry-exhausted': (_event, deps, ss) => {
    ss.markAutoRetryExhausted();
    deps.addNotice('warn', "⚠ Auto-retry exhausted — model couldn't recover on its own.");
  },

  'all-denied-halt': (event, deps) =>
    deps.addNotice(
      'warn',
      `⏸ All ${event.count} tool call${event.count === 1 ? '' : 's'} this turn were denied — halting. Tell the model what to do differently.`,
    ),

  'tool-call-corrected': (event, deps) =>
    deps.addNotice(
      'warn',
      `↺ Auto-correcting ${event.original.function.name} call (${event.reason.slice(0, 80)})...`,
    ),

  'tool-call-corrector-aborted': (event, deps) =>
    deps.addNotice('info', `↺ Corrector skipped: ${event.reason.slice(0, 100)}`),

  'tool-call-planned': (event, deps) => {
    const sig = `${event.toolName}:${JSON.stringify(event.args)}`;
    const dup = deps.getPlannedCalls().some(p => `${p.toolName}:${JSON.stringify(p.args)}` === sig);
    if (dup) {
      deps.addNotice('info', `[planned] (skipped duplicate ${event.toolName} call)`);
      return;
    }
    deps.setPlannedCalls(prev => [...prev, { toolName: event.toolName, args: event.args }]);
    deps.addItem({
      kind: 'tool-planned',
      id: deps.nextId(),
      toolName: event.toolName,
      args: event.args,
    });
  },

  'permission-request': (event, deps) => {
    deps.setState('awaiting-permission');
    const { respond, toolName } = event;
    deps.setPermissionRequest({
      toolName,
      args: event.args,
      resolve: decision => {
        deps.refs.current?.sessionLogger?.logPermissionChange(`request:${decision}`, toolName);
        respond(decision);
        deps.setPermissionRequest(undefined);
        deps.setState('running');
      },
    });
  },

  'output-cap-reached': (event, deps) =>
    deps.addNotice(
      'warn',
      `⚠ Output cap reached (${event.completionTokens} tokens). Response was truncated — ask for the rest if needed.`,
    ),

  'empty-turn-warning': (event, deps) =>
    deps.addNotice(
      'warn',
      `⚠ Model produced ${event.completionTokens} tokens of internal reasoning but no visible output. ` +
        `Try a different model or a more concrete prompt.`,
    ),

  'repetition-detected': (event, deps) =>
    deps.addNotice(
      'danger',
      `⚠ Runaway repetition (${event.streak} identical lines: ${event.line.slice(0, 60)}). Aborting.`,
    ),

  'read-cache-hit': (event, deps) =>
    deps.addNotice('info', `⤳ Read cache hit: ${event.path} unchanged`),

  'key-rotation': (event, deps) => {
    const refs = deps.refs.current;
    // Mirror the new keyId into the session log via a same-model model-change
    // row. Without this, rollupSessionLines keeps the original keyId from
    // session-start, so getLastSessionSelection / getRecentSessions surface a
    // stale keyId after rotation.
    if (refs && event.to.keyId) {
      refs.sessionLogger?.logModelChange(refs.model, refs.model, event.to.keyId);
    }
    const fromLabel = event.from ? fingerprintLabel(event.from) : '<unknown>';
    const toLabel = fingerprintLabel(event.to);
    const reasonLabel = describeRotationReason(event.reason);
    deps.addNotice('warn', `⟲ key ${fromLabel} ${reasonLabel}, rotating to ${toLabel}`);
    deps.setActivity(`rotating key (${event.reason})`);
    if (event.from?.keyId) {
      void recordKeyFailure(event.provider, event.from.keyId, event.reason);
    }
  },

  'provider-retry': (event, deps) => {
    // Show the in-flight retry on the status bar in place of "running" so
    // the user sees why the agent is paused. Reason+attempt+delay together
    // give them enough info to decide whether to abort. Cleared by
    // text-chunk (success) or by the next rotation/retry event.
    const seconds = (event.delayMs / 1000).toFixed(1);
    deps.setActivity(
      `retrying ${event.attempt}/${event.maxAttempts} (${event.reason}, ${seconds}s)`,
    );
  },

  'key-rotation-exhausted': (event, deps) => {
    const reasonLabel = describeRotationReason(event.reason);
    deps.addNotice('warn', `⟲ no more keys for ${event.provider} (${reasonLabel})`);
    // The active key at this moment is the one that just exhausted the pool —
    // record its failure so the user sees it in /keys.
    const refs = deps.refs.current;
    if (refs?.activeKeyId) {
      void recordKeyFailure(event.provider, refs.activeKeyId, event.reason);
    }
  },

  'tuple-rotation': (event, deps) => {
    const refs = deps.refs.current;
    refs?.sessionLogger?.logModelChange(
      event.from.model,
      event.to.model,
      refs.activeKeyId,
      event.to.provider,
    );
    const reasonLabel = describeRotationReason(event.reason);
    deps.addNotice(
      'warn',
      `⟲ ${event.from.provider}/${event.from.model} ${reasonLabel}, falling back to ${event.to.provider}/${event.to.model}`,
    );
    deps.setActivity(`rotating: ${event.from.provider} → ${event.to.provider} (${event.reason})`);
  },

  'tuple-rotation-exhausted': (event, deps) =>
    deps.addNotice(
      'warn',
      `⟲ rotation chain exhausted (${describeRotationReason(event.reason)}); surfacing error`,
    ),

  'bash-dedup-nudge': (event, deps) =>
    deps.addNotice(
      'warn',
      `↻ Near-duplicate Bash pattern (${event.recentCommands.length} recent commands) — nudge injected.`,
    ),

  'hook-veto': (event, deps) => {
    const reason = event.errorMessage ? ` — ${event.errorMessage}` : '';
    deps.addNotice('warn', `⛔ ${event.event} hook vetoed ${event.toolName}${reason}`);
  },

  'hook-error': (event, deps) => deps.addNotice('warn', `⚠ Hook ${event.event}: ${event.error}`),

  'hook-fired': (event, deps) => {
    const name = event.hookCommand.split(/\s+/)[0] ?? event.hookCommand;
    const display = name.split('/').pop() ?? name;
    const suffix = event.notice ? ` — ${event.notice}` : '';
    deps.addNotice('info', `↪ ${event.event} hook ran (${display})${suffix}`);
  },

  'compaction-start': (event, deps) => {
    deps.setCompacting({ aggressive: event.aggressive });
    deps.setThinking(false);
    deps.addNotice(
      'info',
      event.aggressive
        ? '⊕ Context full — aggressively compacting (mechanical summary)…'
        : '⊕ Compacting conversation history…',
    );
  },

  compaction: (event, deps) => {
    deps.setCompacting(null);
    deps.setThinking(true);
    deps.addNotice(
      'info',
      `✓ Compacted ${event.oldMessages} messages → ${event.newMessages}` +
        (event.aggressive ? ' (aggressive pass)' : ''),
    );
    // Conversation just shrank — refresh so the status bar reflects it before
    // the next model response.
    deps.refreshTokenEstimate();
  },

  error: (event, deps) => deps.addNotice('danger', `Error: ${event.error.message}`),

  'turn-complete': (event, deps, ss) => {
    deps.setSessionTurns(n => n + event.turnsUsed);
    if (event.usage) deps.setLastUsage(event.usage);
    // Always clear any leftover activity at turn boundary — even a turn
    // that ended in error shouldn't leave a stale "retrying…" label up.
    deps.setActivity(null);
    if (event.stopReason === 'token-limit') ss.markTokenLimitHalt();
    // Record success for whichever (provider, key) the turn ended on.
    // refs.activeKeyId reflects post-rotation state by this point.
    if (event.stopReason !== 'completed') return;
    const refs = deps.refs.current;
    if (!refs?.activeKeyId) return;
    void recordKeySuccess(refs.provider.name, refs.activeKeyId);
    if (event.usage) {
      void recordKeyTokenUsage(refs.provider.name, refs.activeKeyId, event.usage);
    }
  },

  'pre-turn-stats': () => {
    // Telemetry-only — emitted so the session log can graph context growth
    // across turns. Nothing to render in the TUI.
  },
};

export function handleAgentEvent(event: AgentEvent, deps: AgentLoopDeps, ss: StreamingState): void {
  if (!deps.refs.current) return;
  // The handlers map is keyed by event.type with each entry narrowed to that
  // variant. The runtime cast to a generic handler is safe because TS already
  // proved each entry's input matches its key.
  const handler = HANDLERS[event.type] as
    | ((event: AgentEvent, deps: AgentLoopDeps, ss: StreamingState) => void)
    | undefined;
  if (handler) handler(event, deps, ss);
}
