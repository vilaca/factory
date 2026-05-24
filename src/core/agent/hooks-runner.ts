import type { Provider } from '../../providers/types.js';
import type { AgentEvent, AgentOptions } from './types.js';
import type { Conversation } from '../context/conversation.js';
import { runHook } from '../hooks/index.js';
import { errorMessage } from '../../utils/errors.js';

/** UserPromptSubmit fires once per runAgent call, before the user message
 *  enters the model loop. Return value is informational only — we log
 *  errors but don't act on `cancel` here (a vetoed user prompt would be
 *  surprising; users can just press Esc). Extracted from the runAgent
 *  generator body to keep that function under the per-function line cap. */
export async function* fireUserPromptSubmit(
  userInput: string,
  options: AgentOptions,
  provider: Provider,
  model: string,
  conversation: Conversation,
): AsyncGenerator<AgentEvent> {
  try {
    // UserPromptSubmit fires before any tools have run, so cwdRef.current
    // (if supplied) still equals process.cwd() at this point. Fresh read
    // anyway to keep the pattern uniform with PreToolUse/PostToolUse,
    // which DO need it live (Bash `cd` may have updated cwdRef mid-turn).
    const cwd = options.cwdRef?.current ?? process.cwd();
    const result = await runHook(
      'UserPromptSubmit',
      { userInput, model, provider: provider.name },
      {
        cwd,
        config: options.hooksConfig,
        envPolicy: options.envPolicy,
        onStderr: options.onHookStderr,
      },
    );
    for (const e of result.errors) {
      options.onHookError?.('UserPromptSubmit', e);
      yield { type: 'hook-error', event: 'UserPromptSubmit', error: e };
    }
    for (const hookCommand of result.firedCommands) {
      yield {
        type: 'hook-fired',
        event: 'UserPromptSubmit',
        hookCommand,
        ...(result.notice ? { notice: result.notice } : {}),
      };
    }
    // Inject the hook's additionalContext as a follow-up user message so
    // the model sees it before answering. Distinct from the original user
    // input so a transcript still shows what the user actually typed.
    if (result.additionalContext) {
      conversation.addUser(result.additionalContext);
    }
  } catch (err: unknown) {
    yield { type: 'hook-error', event: 'UserPromptSubmit', error: errorMessage(err) };
  }
}

/** Fire the Stop or StopFailure hook before each turn-complete yield. Stop
 *  fires on `stopReason: 'completed'`; StopFailure fires on every other
 *  reason (error, token-limit, user-abort) so hook authors can scope a
 *  matcher to "the run actually finished" vs "it bailed". Yields
 *  hook-fired/error events for the host. */
export async function* fireStopHook(
  options: AgentOptions,
  turnsUsed: number,
  stopReason: string,
): AsyncGenerator<AgentEvent> {
  if (!options.experimental?.hooks) return;
  const event: 'Stop' | 'StopFailure' = stopReason === 'completed' ? 'Stop' : 'StopFailure';
  const cwd = options.cwdRef?.current ?? process.cwd();
  try {
    const result = await runHook(
      event,
      { turnsUsed, stopReason },
      {
        cwd,
        config: options.hooksConfig,
        envPolicy: options.envPolicy,
        onStderr: options.onHookStderr,
      },
    );
    for (const e of result.errors) {
      options.onHookError?.(event, e);
      yield { type: 'hook-error', event, error: e };
    }
    for (const hookCommand of result.firedCommands) {
      yield {
        type: 'hook-fired',
        event,
        hookCommand,
        ...(result.notice ? { notice: result.notice } : {}),
      };
    }
  } catch (err: unknown) {
    const msg = errorMessage(err);
    options.onHookError?.(event, msg);
    yield { type: 'hook-error', event, error: msg };
  }
}
