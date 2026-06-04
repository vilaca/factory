// Backwards-compatible façade: keep existing imports from
// `core/session/session-log.js` working while the implementation lives in
// `core/session/session-log/*`.

export { createSessionLogger } from './session-log/writer.js';
export { sessionsDir } from './session-log/reader.js';
export {
  getLastSessionSelection,
  getRecentSessions,
  loadHistoryFromSessions,
} from './session-log/rollups.js';

export type { SessionLogger } from './session-log/writer.js';
export type {
  SessionStartMeta,
  LastSessionSelection,
  RecentSession,
  ProviderAuthMeta,
  ModelRequestMeta,
  SessionLoggerOpts,
  SessionErrorStatus,
} from './session-log/types.js';
