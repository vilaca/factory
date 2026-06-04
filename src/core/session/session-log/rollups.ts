import type { ModelSelection, SessionErrorStatus } from '../../selection/types.js';
import type { LastSessionSelection, RecentSession } from './types.js';
import { extractUserInputs, listSessionLogs, readSessionLines } from './reader.js';

const STARTUP_MODEL_PLACEHOLDER = '<startup>';

function classifyErrorMessage(message: string): SessionErrorStatus {
  const m = message.toLowerCase();
  if (/(\b429\b|rate[ -]?limit|throttl)/.test(m)) return 'throttle';
  if (/quota|insufficient|out of (free )?credit|credit balance/.test(m)) return 'quota';
  if (/(\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication)/.test(m))
    return 'permission';
  return 'error';
}

interface SessionStartHeader extends ModelSelection {
  startedAt: string;
}

/** Parse the session-start line; returns null if it isn't one or is malformed. */
function parseSessionStart(line: string): SessionStartHeader | null {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry.type !== 'session-start') return null;
  if (typeof entry.provider !== 'string' || typeof entry.model !== 'string') return null;
  if (!entry.provider || !entry.model) return null;
  const header: SessionStartHeader = {
    provider: entry.provider,
    model: entry.model,
    startedAt: typeof entry.ts === 'string' ? entry.ts : '',
  };
  if (typeof entry.keyId === 'string' && entry.keyId) header.keyId = entry.keyId;
  return header;
}

interface SessionRollup extends ModelSelection {
  userInputCount: number;
  lastErrorMessage: string | null;
}

/**
 * Walk every line after session-start, applying its effect on the session's
 * final (model, keyId, error, user-input count). The latest model-change
 * wins for model/keyId; the latest error wins for status; user-input count
 * is needed to skip abandoned probes.
 */
function rollupSessionLines(lines: string[], header: SessionStartHeader): SessionRollup {
  let model = header.model;
  let provider = header.provider;
  let keyId = header.keyId;
  let userInputCount = 0;
  let lastErrorMessage: string | null = null;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'user-input') {
      userInputCount++;
      continue;
    }
    if (
      entry.type === 'model-change' &&
      typeof entry.to === 'string' &&
      entry.to !== STARTUP_MODEL_PLACEHOLDER
    ) {
      model = entry.to;
      if (typeof entry.providerAfter === 'string' && entry.providerAfter) {
        provider = entry.providerAfter;
      }
      if (typeof entry.keyId === 'string' && entry.keyId) keyId = entry.keyId;
      continue;
    }
    if (entry.type === 'agent-event') {
      const event = entry.event as { type?: string; error?: { message?: unknown } } | undefined;
      if (event?.type === 'error' && typeof event.error?.message === 'string') {
        lastErrorMessage = event.error.message;
      }
    }
  }

  return { model, provider, keyId, userInputCount, lastErrorMessage };
}

/** Read one session log into a RecentSession entry, or null if it should be skipped. */
async function readRecentSession(filePath: string): Promise<RecentSession | null> {
  let lines: string[];
  try {
    lines = await readSessionLines(filePath);
  } catch {
    return null;
  }
  if (lines.length === 0) return null;

  const header = parseSessionStart(lines[0]!);
  if (!header) return null;

  const rollup = rollupSessionLines(lines.slice(1), header);
  if (rollup.userInputCount === 0) return null;

  const status = rollup.lastErrorMessage
    ? classifyErrorMessage(rollup.lastErrorMessage)
    : undefined;
  return {
    provider: rollup.provider,
    model: rollup.model,
    startedAt: header.startedAt,
    ...(status ? { status } : {}),
    ...(rollup.keyId ? { keyId: rollup.keyId } : {}),
  };
}

/**
 * Returns the provider + model used in the most recent session log, or null if none.
 * Walks `model-change` rows (including `providerAfter`) like {@link getRecentSessions}.
 */
export async function getLastSessionSelection(): Promise<LastSessionSelection | null> {
  const sessions = await listSessionLogs();
  if (sessions.length === 0) return null;
  try {
    const lines = await readSessionLines(sessions[0]!.path);
    if (lines.length === 0) return null;
    const header = parseSessionStart(lines[0]!);
    if (!header) return null;
    const rollup = rollupSessionLines(lines.slice(1), header);
    const finalModel = rollup.model !== STARTUP_MODEL_PLACEHOLDER ? rollup.model : undefined;
    if (!finalModel) return null;
    return {
      provider: rollup.provider,
      model: finalModel,
      ...(rollup.keyId ? { keyId: rollup.keyId } : {}),
    };
  } catch {
    // ignore
  }
  return null;
}

/**
 * Returns up to `limit` recent sessions, newest first, deduplicated by
 * provider+model — only the most recent session per pair survives. Sessions
 * that recorded no user input are skipped (e.g. abandoned probes from tests
 * or crashes before the first prompt). Status is set only when the surviving
 * session recorded a model-side error.
 */
export async function getRecentSessions(limit = 16): Promise<RecentSession[]> {
  const sessions = await listSessionLogs();
  // Read up to 4x the requested limit concurrently — most files survive
  // dedupe, but some collapse on provider/model. Capping the fan-out keeps
  // long history directories from spawning hundreds of fs reads.
  const fanout = Math.min(sessions.length, limit * 4);
  const entries = await Promise.all(sessions.slice(0, fanout).map(s => readRecentSession(s.path)));
  const seen = new Set<string>();
  const out: RecentSession[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (out.length >= limit) break;
    const dedupKey = `${entry.provider}/${entry.model}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push(entry);
  }
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return out;
}

/**
 * Load up to `limit` user-input strings from recent session logs, newest first.
 * Used to pre-populate the REPL's readline history so up-arrow recalls past inputs.
 * Consecutive duplicates are collapsed.
 */
export async function loadHistoryFromSessions(limit = 500): Promise<string[]> {
  const sessions = await listSessionLogs();
  // Reading ~16 sessions usually exceeds the 500-entry cap; cap the
  // concurrent fan-out so absurdly long history directories don't open
  // hundreds of file descriptors at once.
  const FANOUT_CAP = 32;
  const slice = sessions.slice(0, FANOUT_CAP);
  const perSessionInputs = await Promise.all(
    slice.map(s => extractUserInputs(s.path).catch(() => [] as string[])),
  );
  const history: string[] = [];
  for (const inputs of perSessionInputs) {
    for (let i = inputs.length - 1; i >= 0; i--) {
      const input = inputs[i]!;
      if (history[history.length - 1] === input) continue;
      history.push(input);
      if (history.length >= limit) return history;
    }
  }
  return history;
}
