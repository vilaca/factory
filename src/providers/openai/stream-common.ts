/**
 * Shared streaming utilities for the OpenAI provider — used by both the
 * /chat/completions transport (stream.ts) and the /responses transport
 * (responses-stream.ts). Anything that landed in both files verbatim
 * belongs here.
 */

import { SseIdleTimeoutError } from './sse.js';

// TODO(timeouts/idle): make idle threshold model-aware. Reasoning models
// (o1/o3/o4/gpt-5/gpt-5-codex — see provider.ts:313-325) can sit silent for
// 30-90s before emitting first token; the current 30s default times those
// out spuriously. Pick a longer window when isReasoningModel(modelId).
// NOTE: this idle timer is an intentional improvement beyond OpenAI SDK
// behavior (the SDK has no idle detection) — keep it, it's what fixes the
// original 5-minute mid-stream hang.
export function openAiSseIdleTimeoutMs(): number {
  const raw = Number(process.env.FACTORY_OPENAI_SSE_IDLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

// TODO(timeouts/request): add a request-level cap on top of the idle timer
// to match OpenAI SDK parity (openai-node / openai-python default 10 min).
// Implementation: second setTimeout next to createLinkedAbortController in
// each streaming entry point that aborts the same controller; does NOT
// reset on activity. Map fired abort to apiError(provider, 408, 'OpenAI
// request timeout'). Catches slow-but-live streams the idle timer doesn't.

/** Build an AbortController that forwards aborts from an optional upstream
 *  signal. Returns a `dispose` function the caller must invoke in a finally
 *  block to detach the forwarder so the upstream signal isn't kept alive by
 *  a listener after the request settles. */
export function createLinkedAbortController(signal: AbortSignal | undefined): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  if (!signal) {
    return { controller, dispose: () => undefined };
  }

  if (signal.aborted) {
    controller.abort(signal.reason);
    return { controller, dispose: () => undefined };
  }

  const forwardAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener('abort', forwardAbort, { once: true });
  return {
    controller,
    dispose: () => signal.removeEventListener('abort', forwardAbort),
  };
}

/** Sentinel used as the abort `reason` when the idle watchdog aborts the
 *  linked controller. Lets the stream catch sites distinguish idle aborts
 *  from user-initiated ones with `instanceof` instead of message matching. */
export class OpenAiSseIdleAbortReason extends Error {
  constructor() {
    super('OpenAI SSE stream idle timeout');
    this.name = 'OpenAiSseIdleAbortReason';
  }
}

/** True when an error thrown out of the SSE pipeline represents an idle
 *  timeout — either parseSseStream rejected with an SseIdleTimeoutError,
 *  or the linked AbortController was aborted with our sentinel reason.
 *  Centralizes the check so the two transports stay aligned and the
 *  detection isn't done by string matching on `error.message`. */
export function isIdleTimeoutFailure(error: unknown, controller: AbortController): boolean {
  if (controller.signal.aborted && controller.signal.reason instanceof OpenAiSseIdleAbortReason) {
    return true;
  }
  return error instanceof SseIdleTimeoutError;
}
