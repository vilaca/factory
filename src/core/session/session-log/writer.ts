import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { AgentEvent } from '../../agent/types.js';
import { errorMessage } from '../../../utils/errors.js';
import { factoryHomePath } from '../../../utils/factory-paths.js';
import type {
  SessionStartMeta,
  ProviderAuthMeta,
  ModelRequestMeta,
  SessionLoggerOpts,
} from './types.js';

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
