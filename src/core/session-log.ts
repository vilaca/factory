import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { AgentEvent } from './agent-types.js';

export interface SessionStartMeta {
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
}

export interface SessionLogger {
  filePath: string;
  logSessionStart(meta: SessionStartMeta): void;
  logProviderAuth(meta: ProviderAuthMeta): void;
  logUserInput(content: string): void;
  logAgentEvent(event: AgentEvent): void;
  logCommand(command: string, arg: string): void;
  logModelChange(from: string, to: string): void;
  logSystemPromptChange(reason: string): void;
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

export interface LastSessionSelection {
  provider: string;
  model: string;
}

export interface ProviderAuthMeta {
  provider: string;
  action: string;
  outcome: 'started' | 'success' | 'error' | 'skipped';
  detail?: string;
}

const STARTUP_MODEL_PLACEHOLDER = '<startup>';

export function createSessionLogger(): SessionLogger {
  const dir = path.join(os.homedir(), '.factory', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const id = crypto.randomBytes(3).toString('hex');
  const filePath = path.join(dir, `${ts}-${id}.jsonl`);
  const fd = fs.openSync(filePath, 'a');
  let closed = false;

  const write = (entry: Record<string, unknown>): void => {
    if (closed) return;
    try {
      fs.writeSync(fd, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    } catch {
      // Logging failures must never crash the REPL
    }
  };

  return {
    filePath,
    logSessionStart(meta) { write({ type: 'session-start', ...meta }); },
    logProviderAuth(meta) { write({ type: 'provider-auth', ...meta }); },
    logUserInput(content) { write({ type: 'user-input', content }); },
    logCommand(command, arg) { write({ type: 'command', command, arg }); },
    logModelChange(from, to) { write({ type: 'model-change', from, to }); },
    logSystemPromptChange(reason) { write({ type: 'system-prompt-change', reason }); },
    logPermissionChange(action, toolName) { write({ type: 'permission-change', action, toolName }); },
    logStuckPattern(consecutiveCount) { write({ type: 'stuck-pattern', consecutiveCount }); },
    logWarning(source, message) { write({ type: 'warning', source, message }); },
    logGitChange(prev, next) { write({ type: 'git-change', prev, next }); },
    logAgentEvent(event) {
      write({ type: 'agent-event', event: serializeEvent(event) });
    },
    logSessionEnd() { write({ type: 'session-end' }); },
    close() {
      if (closed) return;
      closed = true;
      try { fs.closeSync(fd); } catch { /* ignore */ }
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
  return path.join(os.homedir(), '.factory', 'sessions');
}

export interface ProviderLogEvent {
  provider: string;
  category: 'auth' | 'diagnostic' | 'startup';
  action: string;
  outcome?: 'started' | 'success' | 'error' | 'skipped';
  detail: string;
}

export function providerEventsLogPath(): string {
  return path.join(os.homedir(), '.factory', 'provider-events.jsonl');
}

export function appendProviderLog(event: ProviderLogEvent): void {
  try {
    const filePath = providerEventsLogPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify({
      ts: new Date().toISOString(),
      ...event,
    }) + '\n');
  } catch {
    // Logging failures must never crash startup or the REPL
  }
}

export async function listSessionLogs(): Promise<{ name: string; path: string; mtime: Date }[]> {
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

export async function extractUserInputs(filePath: string): Promise<string[]> {
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
 * Returns the model name used in the most recent session log, or null if none.
 * Reads only the first line of the newest log (the session-start event).
 */
export async function getLastSessionModel(): Promise<string | null> {
  const selection = await getLastSessionSelection();
  return selection?.model ?? null;
}

/**
 * Returns the provider + model used in the most recent session log, or null if none.
 * Reads only the first line of the newest log (the session-start event).
 */
export async function getLastSessionSelection(): Promise<LastSessionSelection | null> {
  const sessions = await listSessionLogs();
  if (sessions.length === 0) return null;
  try {
    const raw = await fs.promises.readFile(sessions[0].path, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    const entry = JSON.parse(lines[0]);
    if (
      entry.type === 'session-start' &&
      typeof entry.provider === 'string' &&
      typeof entry.model === 'string'
    ) {
      if (entry.model !== STARTUP_MODEL_PLACEHOLDER) {
        return { provider: entry.provider, model: entry.model };
      }
      for (let i = lines.length - 1; i >= 1; i--) {
        const candidate = JSON.parse(lines[i]);
        if (
          candidate.type === 'model-change' &&
          typeof candidate.to === 'string' &&
          candidate.to !== STARTUP_MODEL_PLACEHOLDER
        ) {
          return { provider: entry.provider, model: candidate.to };
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export function getStartupModelPlaceholder(): string {
  return STARTUP_MODEL_PLACEHOLDER;
}

/**
 * Load up to `limit` user-input strings from recent session logs, newest first.
 * Used to pre-populate the REPL's readline history so up-arrow recalls past inputs.
 * Consecutive duplicates are collapsed.
 */
export async function loadHistoryFromSessions(limit = 500): Promise<string[]> {
  const sessions = await listSessionLogs();
  const history: string[] = [];
  for (const session of sessions) {
    const inputs = await extractUserInputs(session.path).catch(() => []);
    // Within a session, push newest-first (the file is oldest-first, so reverse).
    for (let i = inputs.length - 1; i >= 0; i--) {
      const input = inputs[i];
      if (history[history.length - 1] === input) continue;
      history.push(input);
      if (history.length >= limit) return history;
    }
  }
  return history;
}
