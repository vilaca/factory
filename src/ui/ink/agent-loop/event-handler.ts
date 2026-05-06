import type { AgentEvent } from '../../../core/agent-types.js';
import type { AgentLoopDeps } from './types.js';
import {
  recordFailure as recordKeyFailure,
  recordSuccess as recordKeySuccess,
  recordTokenUsage as recordKeyTokenUsage,
} from '../../../core/key-stats.js';

export interface StreamingState {
  getStreamingBuffer: () => string;
  setStreamingBuffer: (s: string) => void;
  addSuccessfulToolCall: () => void;
  markAutoRetryExhausted: () => void;
  markTokenLimitHalt: () => void;
}

export function handleAgentEvent(
  event: AgentEvent,
  deps: AgentLoopDeps,
  ss: StreamingState,
): void {
  if (!deps.refs.current) return;

  switch (event.type) {
    case 'text-chunk': {
      deps.setThinking(false);
      const next = ss.getStreamingBuffer() + event.content;
      ss.setStreamingBuffer(next);
      deps.setStreamingText(next);
      break;
    }
    case 'text-done': {
      // Commit the finalized text to items[] (which feeds <Static>) and
      // clear the streaming buffer. <Static> keeps history in the terminal's
      // real scrollback; only the streaming buffer + spinner re-render.
      if (event.fullContent) {
        deps.addItem({ kind: 'assistant-text', id: deps.nextId(), text: event.fullContent, streaming: false });
      }
      ss.setStreamingBuffer('');
      deps.setStreamingText('');
      deps.setThinking(true);
      deps.refreshTokenEstimate();
      break;
    }
    case 'tool-call-start': {
      deps.setThinking(false);
      deps.setRunningTool(event.toolName);
      // Hold the call in the dynamic region instead of committing it to
      // <Static> immediately. We don't yet know whether it's going to
      // resolve as ok/denied, and Static can't re-render past items.
      deps.setPendingToolCall({ toolName: event.toolName, args: event.args });
      break;
    }
    case 'tool-call-result': {
      deps.setPendingToolCall(null);
      deps.addItem({ kind: 'tool-call', id: deps.nextId(), toolName: event.toolName, args: event.args, status: 'ok' });
      const preview = event.result.displayOutput ?? event.result.output;
      // Only attach the full version when it actually differs from the
      // preview, so the /full toggle has nothing to expand on tools that
      // already show their entire output (Bash, Glob, Grep).
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
      if (event.result.success) ss.addSuccessfulToolCall();
      deps.setSessionToolCalls((n) => n + 1);
      deps.setRunningTool(null);
      deps.setThinking(true);
      // Tool results add (often large) chunks to the conversation.
      deps.refreshTokenEstimate();
      break;
    }
    case 'tool-call-denied': {
      deps.setPendingToolCall(null);
      deps.addItem({ kind: 'tool-call', id: deps.nextId(), toolName: event.toolName, args: event.args, status: 'denied' });
      deps.setRunningTool(null);
      break;
    }
    case 'tool-call-recovered': {
      if (!deps.refs.current.useTextToolFallback) {
        const sourceLabel =
          event.source === 'bare' ? 'bare JSON' :
          event.source === 'fence' ? 'a JSON code block' :
          event.source === 'shell-fence' ? 'a shell code block' :
          'tagged JSON';
        deps.addNotice('warn',
          `⚠ Model emitted tool call as ${sourceLabel} instead of structured tool_calls. Recovered ${event.count} call${event.count === 1 ? '' : 's'} via fallback parser.`,
        );
        deps.refs.current.useTextToolFallback = true;
        deps.refs.current.conversation.updateSystemPrompt(deps.composeSystemPrompt());
        deps.refs.current.sessionLogger?.logSystemPromptChange('text-tool-fallback=true (auto)');
        deps.addNotice('warn',
          '⚠ Auto-enabling text-tool fallback mode — model will be instructed to use <tool_call> format from now on. Subsequent recoveries will be silent.',
        );
      }
      break;
    }
    case 'tool-result-imitation-stripped': {
      deps.addNotice('danger',
        `⚠ Model fabricated ${event.count} tool result block${event.count === 1 ? '' : 's'} in its response. Stripped before storing — the result was NOT real.`,
      );
      break;
    }
    case 'auto-retry-injected': {
      deps.addNotice('warn',
        `↻ Model bailed after a tool failure — auto-injecting retry nudge (${event.remainingBudget} retr${event.remainingBudget === 1 ? 'y' : 'ies'} left).`,
      );
      break;
    }
    case 'auto-retry-exhausted': {
      ss.markAutoRetryExhausted();
      deps.addNotice('warn', '⚠ Auto-retry exhausted — model couldn\'t recover on its own.');
      break;
    }
    case 'all-denied-halt': {
      deps.addNotice('warn',
        `⏸ All ${event.count} tool call${event.count === 1 ? '' : 's'} this turn were denied — halting. Tell the model what to do differently.`,
      );
      break;
    }
    case 'tool-call-corrected': {
      deps.addNotice('warn',
        `↺ Auto-correcting ${event.original.function.name} call (${event.reason.slice(0, 80)})...`,
      );
      break;
    }
    case 'tool-call-corrector-aborted': {
      deps.addNotice('info', `↺ Corrector skipped: ${event.reason.slice(0, 100)}`);
      break;
    }
    case 'tool-call-planned': {
      const sig = `${event.toolName}:${JSON.stringify(event.args)}`;
      const dup = deps.getPlannedCalls().some(p => `${p.toolName}:${JSON.stringify(p.args)}` === sig);
      if (dup) {
        deps.addNotice('info', `[planned] (skipped duplicate ${event.toolName} call)`);
      } else {
        deps.setPlannedCalls((prev) => [...prev, { toolName: event.toolName, args: event.args }]);
        deps.addItem({ kind: 'tool-planned', id: deps.nextId(), toolName: event.toolName, args: event.args });
      }
      break;
    }
    case 'permission-request': {
      deps.setState('awaiting-permission');
      const respond = event.respond;
      const toolName = event.toolName;
      deps.setPermissionRequest({
        toolName,
        args: event.args,
        resolve: (decision) => {
          deps.refs.current?.sessionLogger?.logPermissionChange(`request:${decision}`, toolName);
          respond(decision);
          deps.setPermissionRequest(undefined);
          deps.setState('running');
        },
      });
      break;
    }
    case 'output-cap-reached': {
      deps.addNotice('warn',
        `⚠ Output cap reached (${event.completionTokens} tokens). Response was truncated — ask for the rest if needed.`,
      );
      break;
    }
    case 'empty-turn-warning': {
      deps.addNotice('warn',
        `⚠ Model produced ${event.completionTokens} tokens of internal reasoning but no visible output. ` +
        `Try a different model or a more concrete prompt.`,
      );
      break;
    }
    case 'repetition-detected': {
      deps.addNotice('danger',
        `⚠ Runaway repetition (${event.streak} identical lines: ${event.line.slice(0, 60)}). Aborting.`,
      );
      break;
    }
    case 'read-cache-hit': {
      deps.addNotice('info', `⤳ Read cache hit: ${event.path} unchanged`);
      break;
    }
    case 'key-rotation': {
      const fromLabel = event.from
        ? (event.from.label ? `${event.from.label} · …${event.from.fingerprint}` : `…${event.from.fingerprint}`)
        : '<unknown>';
      const toLabel = event.to.label
        ? `${event.to.label} · …${event.to.fingerprint}`
        : `…${event.to.fingerprint}`;
      const reasonLabel = event.reason === 'rate-limit' ? 'rate-limited' : 'auth failed';
      deps.addNotice('warn', `⟲ key ${fromLabel} ${reasonLabel}, rotating to ${toLabel}`);
      if (event.from?.keyId) {
        void recordKeyFailure(event.provider, event.from.keyId, event.reason);
      }
      break;
    }
    case 'key-rotation-exhausted': {
      const reasonLabel = event.reason === 'rate-limit' ? 'rate-limited' : 'auth failed';
      deps.addNotice('warn', `⟲ no more keys for ${event.provider} (${reasonLabel})`);
      // The active key at this moment is the one that just exhausted the
      // pool — record its failure so the user sees it in /keys.
      const refs = deps.refs.current;
      if (refs?.activeKeyId) {
        void recordKeyFailure(event.provider, refs.activeKeyId, event.reason);
      }
      break;
    }
    case 'tuple-rotation': {
      const reasonLabel = event.reason === 'rate-limit' ? 'rate-limited' : 'auth failed';
      deps.addNotice(
        'warn',
        `⟲ ${event.from.provider}/${event.from.model} ${reasonLabel}, falling back to ${event.to.provider}/${event.to.model}`,
      );
      break;
    }
    case 'tuple-rotation-exhausted': {
      const reasonLabel = event.reason === 'rate-limit' ? 'rate-limited' : 'auth failed';
      deps.addNotice('warn', `⟲ rotation chain exhausted (${reasonLabel}); surfacing error`);
      break;
    }
    case 'bash-dedup-nudge': {
      deps.addNotice('warn',
        `↻ Near-duplicate Bash pattern (${event.recentCommands.length} recent commands) — nudge injected.`,
      );
      break;
    }
    case 'compaction-start': {
      deps.setCompacting({ aggressive: event.aggressive });
      deps.setThinking(false);
      deps.addNotice(
        'info',
        event.aggressive
          ? '⊕ Context full — aggressively compacting (mechanical summary)…'
          : '⊕ Compacting conversation history…',
      );
      break;
    }
    case 'compaction': {
      deps.setCompacting(null);
      deps.setThinking(true);
      deps.addNotice(
        'info',
        `✓ Compacted ${event.oldMessages} messages → ${event.newMessages}` +
          (event.aggressive ? ' (aggressive pass)' : ''),
      );
      // Conversation just shrank — refresh so the status bar reflects it
      // before the next model response.
      deps.refreshTokenEstimate();
      break;
    }
    case 'error': {
      deps.addNotice('danger', `Error: ${event.error.message}`);
      break;
    }
    case 'turn-complete': {
      deps.setSessionTurns((n) => n + event.turnsUsed);
      if (event.usage) {
        deps.setLastUsage(event.usage);
      }
      if (event.stopReason === 'token-limit') {
        ss.markTokenLimitHalt();
      }
      // Record success for whichever (provider, key) the turn ended on.
      // refs.activeKeyId reflects post-rotation state by this point.
      if (event.stopReason === 'completed') {
        const refs = deps.refs.current;
        if (refs?.activeKeyId) {
          void recordKeySuccess(refs.provider.name, refs.activeKeyId);
          if (event.usage) {
            void recordKeyTokenUsage(refs.provider.name, refs.activeKeyId, event.usage);
          }
        }
      }
      break;
    }
  }
}
