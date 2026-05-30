import type { SessionLogger } from '../core/session/session-log.js';

type DiagnosticLevel = 'warning' | 'error';

interface Diagnostic {
  level: DiagnosticLevel;
  message: string;
  /** Session-log source tag (e.g. "hook-error"). */
  source?: string;
}

export interface DiagnosticSink {
  emit(diagnostic: Diagnostic): void;
}

export interface DiagnosticEmitter {
  emit(diagnostic: Diagnostic): void;
  warning(message: string, source?: string): void;
  error(message: string, source?: string): void;
}

export function createDiagnosticEmitter(
  ...sinks: Array<DiagnosticSink | undefined>
): DiagnosticEmitter {
  const active = sinks.filter((s): s is DiagnosticSink => Boolean(s));
  const emit = (diagnostic: Diagnostic): void => {
    for (const sink of active) sink.emit(diagnostic);
  };
  return {
    emit,
    warning(message, source) {
      emit({ level: 'warning', message, source });
    },
    error(message, source) {
      emit({ level: 'error', message, source });
    },
  };
}

/**
 * Session-log sink. Uses logWarning for both warning+error rows so we don't
 * change JSONL schema; callers can set `source` to preserve category.
 */
export function sessionLogDiagnosticSink(
  getLogger: () => SessionLogger | undefined,
): DiagnosticSink {
  return {
    emit(diagnostic) {
      const source = diagnostic.source ?? `diagnostic:${diagnostic.level}`;
      getLogger()?.logWarning(source, diagnostic.message);
    },
  };
}

/** Maps diagnostics to TUI notice levels. */
export function tuiDiagnosticSink(
  addNotice: (level: 'warn' | 'danger', text: string) => void,
): DiagnosticSink {
  return {
    emit(diagnostic) {
      addNotice(diagnostic.level === 'warning' ? 'warn' : 'danger', diagnostic.message);
    },
  };
}

/** Emits diagnostics as plain stderr lines for headless mode. */
export function stderrDiagnosticSink(
  writeLine: (line: string) => void = line => process.stderr.write(`${line}\n`),
): DiagnosticSink {
  return {
    emit(diagnostic) {
      writeLine(diagnostic.message);
    },
  };
}
