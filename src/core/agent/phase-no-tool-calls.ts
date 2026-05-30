import type { TokenUsage } from '../../providers/types.js';
import type { AgentEvent, AgentOptions } from './types.js';
import type { RecoveryState } from './recovery-state.js';
import type { ActivationFlags } from './reliability-config.js';
import { validateResponse } from './validator.js';

export interface NoToolCallsInput {
  activation: ActivationFlags;
  storedContent: string;
  fullContent: string;
  lastUsage: TokenUsage | undefined;
  recovery: RecoveryState;
}

/** Three-way outcome of the no-tool-calls branch:
 *  - `continue` ⇒ a nudge was injected (validator retry, or
 *    last-tool-failure corrective); loop must re-iterate.
 *  - `done completed` ⇒ no nudge applicable; finalize the turn. The
 *    outer loop's response-emission phase already committed any
 *    `auto-retry-exhausted` event when the budget was burned. */
export type NoToolCallsResult = { kind: 'continue' } | { kind: 'done'; stopReason: 'completed' };

/** Phase D-alt: model returned no tool calls. Three branches in order:
 *
 *    1. weak-tier text-only with budget → inject retry-nudge, return `continue`.
 *    2. prior tool failure + budget    → inject corrective user message, return `continue`.
 *    3. natural completion             → emit `auto-retry-exhausted` if a
 *       prior failure burned the budget, return `done completed`.
 *
 *  Also yields the silent-turn warning when the model burned 100+
 *  completion tokens with no visible content. */
function isNonRetriableToolFailure(message: string): boolean {
  // Security hard-deny failures are deterministic: retries cannot succeed
  // until the caller changes strategy (different path / external inspection).
  // Don't burn auto-retry budget on them.
  return /Path denied by security policy:/i.test(message);
}

export async function* runNoToolCalls(
  options: AgentOptions,
  input: NoToolCallsInput,
): AsyncGenerator<AgentEvent, NoToolCallsResult> {
  const { activation, storedContent, fullContent, lastUsage, recovery } = input;
  const { conversation, toolRegistry } = options;

  // Reliability path (Phase 4 validator): weak-tier + text-only with
  // any content → inject a retry-nudge and re-loop.
  if (activation.useRespondTool && storedContent.trim().length > 0) {
    const validation = validateResponse([], storedContent, {
      toolNames: new Set(toolRegistry.getNames()),
      enforceToolCall: true,
    });
    if (validation.needsRetry && validation.nudge && recovery.autoRetryBudget > 0) {
      recovery.autoRetryBudget--;
      conversation.addUser(validation.nudge.content, { type: 'retry_nudge' });
      yield {
        type: 'auto-retry-injected',
        remainingBudget: recovery.autoRetryBudget,
        reason: validation.nudge.kind,
      };
      return { kind: 'continue' };
    }
  }

  // Detect "silent" turns where the model burned tokens producing
  // nothing — typical of reasoning-block runaway on thinking-mode
  // models. Without this notice the spinner stops with no output.
  if (!fullContent && lastUsage && lastUsage.completionTokens >= 100) {
    yield { type: 'empty-turn-warning', completionTokens: lastUsage.completionTokens };
  }

  if (recovery.lastFailureMessage && recovery.autoRetryBudget > 0) {
    if (!isNonRetriableToolFailure(recovery.lastFailureMessage)) {
      recovery.autoRetryBudget--;
      conversation.addUser(
        `Your last tool call failed with: "${recovery.lastFailureMessage}". Diagnose the cause and emit a corrected tool call now. Do not reply with prose.`,
      );
      yield {
        type: 'auto-retry-injected',
        remainingBudget: recovery.autoRetryBudget,
        reason: recovery.lastFailureMessage,
      };
      return { kind: 'continue' };
    }
  }

  if (
    recovery.lastFailureMessage &&
    !isNonRetriableToolFailure(recovery.lastFailureMessage) &&
    recovery.autoRetryBudget === 0
  ) {
    yield { type: 'auto-retry-exhausted' };
  }
  return { kind: 'done', stopReason: 'completed' };
}
