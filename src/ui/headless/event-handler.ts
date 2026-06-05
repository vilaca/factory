import type { AgentEvent } from '../../core/agent/types.js';
import {
  describeRotationReason,
  fingerprintLabel,
  formatHookDisplay,
} from '../agent-events/render.js';
import type { DiagnosticEmitter } from '../diagnostics.js';
import { formatArgsBrief, formatScopedInstructionFiles } from './io.js';
import type { HeadlessRunState } from './types.js';

/** Side-effect log of one agent event to stdout/stderr for the headless
 *  runner. Mutates `state` so the caller can thread it through the
 *  for-await loop without hoisting the giant switch into the main function. */
// eslint-disable-next-line complexity -- exhaustive switch over AgentEvent variants; each case is a one-liner.
export function handleAgentEvent(
  event: AgentEvent,
  state: HeadlessRunState,
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
      process.stderr.write(`  ${event.result.success ? '✓' : '✗'} ${event.toolName}\n`);
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
      const seconds = (event.delayMs / 1000).toFixed(1);
      process.stderr.write(
        `  [activity] retrying ${event.attempt}/${event.maxAttempts} (${event.reason}, ${seconds}s)\n`,
      );
      break;
    }
    case 'auto-retry-exhausted':
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
      if (names.length > 0) {
        diagnostics.info(
          `harness queued Read for scoped instruction files: ${names}`,
          'project-instructions-scoped',
        );
      } else {
        diagnostics.info(
          'harness refreshed scoped instruction discovery',
          'project-instructions-scoped',
        );
      }
      break;
    }
    case 'output-cap-reached':
      diagnostics.warning(
        `  ⚠ output cap reached (${event.completionTokens} tokens) — response truncated`,
        'output-cap-reached',
      );
      break;
    case 'output-blocked':
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
