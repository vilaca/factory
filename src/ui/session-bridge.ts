import type { SessionLogger } from '../core/session/session-log.js';
import type { ModelRequestInfo } from '../providers/instrument.js';

/**
 * Bridge from the `providers/instrument.ts` callback shape to
 * `SessionLogger.logModelRequest`. Lives at the UI layer because the
 * modularity rule forbids `src/providers/**` from depending on
 * `src/core/**` (see test/unit/arch/modularity.test.ts) — the provider
 * decorator can't know about SessionLogger directly. Both `headless.ts`
 * and the TUI agent-loop import this helper so they don't drift.
 */
export function logModelRequestTo(
  sessionLogger: SessionLogger | undefined,
  info: ModelRequestInfo,
): void {
  if (!sessionLogger) return;
  sessionLogger.logModelRequest({
    provider: info.provider,
    model: info.model,
    source: info.source,
    streaming: info.streaming,
    messages: info.messages as unknown[],
    ...(info.tools ? { tools: info.tools as unknown[] } : {}),
    ...(info.options ? { options: info.options as unknown as Record<string, unknown> } : {}),
  });
}
