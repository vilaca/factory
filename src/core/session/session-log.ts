import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { AgentEvent } from '../agent/types.js';
import { errorMessage } from '../../utils/errors.js';
import { factoryHomePath } from '../../utils/factory-paths.js';

interface SessionStartMeta {
  model: string;
  provider: string;
  cwd: string;
  experimental?: Record<string, boolean>;
  turnTimeoutSec?: number;
  appVersion?: string;
  buildTimestamp?: string;
  mcp?: { servers: string[]; toolCount: number };
  gitBranch?: string;
  gitDirty?: boolean | null;
  /** Set when the session was opened against a specific saved key. */
  keyId?: string;
}

export interface SessionLogger {
  filePath: string;
  logSessionStart(meta: SessionStartMeta): void;
  logProviderAuth(meta: ProviderAuthMeta): void;
  logUserInput(content: string): void;
  logAgentEvent(event: AgentEvent): void;
  logCommand(command: string, arg: string): void;
  /** When the active backend provider changes (e.g. `/provider openai`), pass
   *  `providerAfter` so recent-session rollup matches the UI — otherwise only
   *  `session-start.provider` is kept and recents mis-label the session. */
  logModelChange(from: string, to: string, keyId?: string, providerAfter?: string): void;
  logSystemPrompt(prompt: string): void;
  logSystemPromptChange(reason: string): void;
  /** Capture every outgoing LLM call (chat + chatNoStream + tool-corrector +
   *  compaction). `source` identifies which caller produced it
   *  (`main` / `compaction` / `corrector` / `subagent` etc.). Messages are
   *  logged verbatim so the JSONL can replay exactly what the model saw. */
  logModelRequest(meta: ModelRequestMeta): void;
  logPermissionChange(action: string, toolName?: string): void;
  logStuckPattern(consecutiveCount: number): void;
  logWarning(source: string, message: string): void;
  logGitChange(
    prev: { branch?: string; dirty: boolean | null },
    next: { branch?: string; dirty: boolean | null },
  ): void;
  logSessionEnd(): void;
  close(): void;
}

interface LastSessionSelection {
  provider: string;
  model: string;
  /** Set when the session was opened against a specific saved key. Older
   *  logs predate the multi-key store and have no keyId — callers must
   *  treat missing keyId as "use the default key for this provider". */
  keyId?: string;
}

export type SessionErrorStatus = 'throttle' | 'quota' | 'permission' | 'error';

export interface RecentSession {
  provider: string;
  model: string;
  startedAt: string;
  status?: SessionErrorStatus;
  /** Same semantics as LastSessionSelection.keyId — optional, missing on old logs. */
  keyId?: string;
}

interface ProviderAuthMeta {
  provider: string;
  action: string;
  outcome: 'started' | 'success' | 'error' | 'skipped';
  detail?: string;
}

interface ModelRequestMeta {
  provider: string;
  model: string;
  /** Which caller issued the request. */
  source: 'main' | 'compaction' | 'corrector' | 'subagent';
  /** Streaming (`chat`) vs. one-shot (`chatNoStream`). */
  streaming: boolean;
  /** Full outgoing message list — system prompt, user turns, tool results,
   *  assistant turns — exactly as handed to the provider. */
  messages: unknown[];
  /** Tool definitions sent alongside, if any. */
  tools?: unknown[];
  /** Whitelisted ChatOptions fields useful for replay (temperature, maxTokens,
   *  responsesChain, …). The shape is provider-shared so we widen to `unknown`. */
  options?: Record<string, unknown>;
}

const STARTUP_MODEL_PLACEHOLDER = '<startup>';

interface SessionLoggerOpts {
  /** Called once, after the first write failure (and after the default
   *  stderr surface fires). Strict-logging callers use this to escalate —
   *  e.g. `process.exit` from headless mode when --strict-log is set. */
  onWriteError?: (err: unknown) => void;
}

export function createSessionLogger(opts?: SessionLoggerOpts): SessionLogger {
  const dir = factoryHomePath('sessions');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const id = crypto.randomBytes(3).toString('hex');
  const filePath = path.join(dir, `${ts}-${id}.jsonl`);
  // Open sync so permission/ENOSPC at init throws to the caller. Per-event
  // writes go through an in-memory queue flushed once per event-loop turn,
  // so a hot loop of tool calls doesn't pay a syscall per log line.
  const fd = fs.openSync(filePath, 'a');
  let closed = false;
  let writeFailureNotified = false;
  let queue: string[] = [];
  let flushScheduled = false;

  const surfaceWriteError = (err: unknown): void => {
    // First failure goes to stderr so the user knows logs went dark; later
    // failures stay silent so a full disk doesn't flood stderr per write.
    // Logging is observability, not a hard dependency, so we never throw
    // out of write(); strict-logging callers escalate via onWriteError.
    if (writeFailureNotified) return;
    writeFailureNotified = true;
    process.stderr.write(
      `factory: session log write failed (${filePath}) — ${errorMessage(err)}\n`,
    );
    opts?.onWriteError?.(err);
  };

  const flush = (): void => {
    flushScheduled = false;
    if (queue.length === 0) return;
    const batch = queue.join('');
    queue = [];
    try {
      fs.writeSync(fd, batch);
    } catch (err) {
      surfaceWriteError(err);
    }
  };

  const write = (entry: Record<string, unknown>): void => {
    if (closed) return;
    queue.push(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    if (!flushScheduled) {
      flushScheduled = true;
      setImmediate(flush);
    }
  };

  return {
    filePath,
    logSessionStart(meta) {
      write({ type: 'session-start', ...meta });
    },
    logProviderAuth(meta) {
      write({ type: 'provider-auth', ...meta });
    },
    logUserInput(content) {
      write({ type: 'user-input', content });
    },
    logCommand(command, arg) {
      write({ type: 'command', command, arg });
    },
    logModelChange(from, to, keyId, providerAfter) {
      write({
        type: 'model-change',
        from,
        to,
        ...(keyId ? { keyId } : {}),
        ...(providerAfter ? { providerAfter } : {}),
      });
    },
    logSystemPrompt(prompt) {
      write({ type: 'system-prompt', content: prompt });
    },
    logModelRequest(meta) {
      write({ type: 'model-request', ...meta });
    },
    logSystemPromptChange(reason) {
      write({ type: 'system-prompt-change', reason });
    },
    logPermissionChange(action, toolName) {
      write({ type: 'permission-change', action, toolName });
    },
    logStuckPattern(consecutiveCount) {
      write({ type: 'stuck-pattern', consecutiveCount });
    },
    logWarning(source, message) {
      write({ type: 'warning', source, message });
    },
    logGitChange(prev, next) {
      write({ type: 'git-change', prev, next });
    },
    logAgentEvent(event) {
      write({ type: 'agent-event', event: serializeEvent(event) });
    },
    logSessionEnd() {
      write({ type: 'session-end' });
    },
    close() {
      if (closed) return;
      closed = true;
      // Drain anything queued so callers that exit immediately after close()
      // (headless mode → process.exit) don't lose the tail of the log.
      flush();
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    },
  };
}

function serializeEvent(event: AgentEvent): Record<string, unknown> {
  if (event.type === 'permission-request') {
    // Destructuring 'respond' to exclude it from serialization since it's a function
    const { respond, ...rest } = event;
    return rest;
  }
  if (event.type === 'error') {
    return { type: event.type, error: { message: event.error.message, stack: event.error.stack } };
  }
  return event as unknown as Record<string, unknown>;
}

export function sessionsDir(): string {
  return factoryHomePath('sessions');
}

async function listSessionLogs(): Promise<{ name: string; path: string; mtime: Date }[]> {
  const dir = sessionsDir();
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const records = await Promise.all(
    entries
      .filter(f => f.endsWith('.jsonl'))
      .map(async name => {
        const fullPath = path.join(dir, name);
        try {
          const stat = await fs.promises.stat(fullPath);
          return { name, path: fullPath, mtime: stat.mtime };
        } catch {
          return null;
        }
      }),
  );
  return records
    .filter((r): r is { name: string; path: string; mtime: Date } => r !== null)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

async function extractUserInputs(filePath: string): Promise<string[]> {
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  const inputs: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry.type === 'user-input' && typeof entry.content === 'string') {
        inputs.push(entry.content);
      }
    } catch {
      // skip malformed lines
    }
  }
  return inputs;
}

/**
 * Returns the provider + model used in the most recent session log, or null if none.
 * Walks `model-change` rows (including `providerAfter`) like {@link getRecentSessions}.
 */
export async function getLastSessionSelection(): Promise<LastSessionSelection | null> {
  const sessions = await listSessionLogs();
  if (sessions.length === 0) return null;
  try {
    const raw = await fs.promises.readFile(sessions[0]!.path, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
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

function classifyErrorMessage(message: string): SessionErrorStatus {
  const m = message.toLowerCase();
  if (/(\b429\b|rate[ -]?limit|throttl)/.test(m)) return 'throttle';
  if (/quota|insufficient|out of (free )?credit|credit balance/.test(m)) return 'quota';
  if (/(\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication)/.test(m))
    return 'permission';
  return 'error';
}

interface SessionStartHeader {
  provider: string;
  model: string;
  startedAt: string;
  keyId?: string;
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

interface SessionRollup {
  model: string;
  provider: string;
  keyId: string | undefined;
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
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').filter(Boolean);
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
  const entries = await Promise.all(
    sessions.slice(0, fanout).map(s => readRecentSession(s.path)),
  );
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
