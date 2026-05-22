import type { SessionLogger } from '../../../core/session/session-log.js';
import type { ModelRequestInfo } from '../../../providers/instrument.js';

/**
 * Bridge from the `providers/instrument.ts` callback shape to `SessionLogger.
 * logModelRequest`. Lives in the UI layer because session-log.ts mustn't
 * depend on provider types (see ADR 0003 — `src/utils/` / primitive layers
 * have no sibling deps; session-log.ts treats payloads as `unknown[]`).
 */
export function logModelRequestFromInfo(
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
