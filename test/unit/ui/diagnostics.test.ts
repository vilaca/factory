import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import {
  createDiagnosticEmitter,
  sessionLogDiagnosticSink,
  tuiDiagnosticSink,
  stderrDiagnosticSink,
} from '../../../src/ui/diagnostics.js';
import type { SessionLogger } from '../../../src/core/session/session-log.js';

describe('createDiagnosticEmitter', () => {
  it('fans out diagnostics to all provided sinks and ignores undefined sinks', () => {
    const sinkA = { emit: mock.fn() };
    const sinkB = { emit: mock.fn() };
    const emitter = createDiagnosticEmitter(sinkA, undefined, sinkB);

    emitter.warning('warn-msg', 'w-source');
    emitter.error('err-msg', 'e-source');

    assert.strictEqual(sinkA.emit.mock.callCount(), 2);
    assert.strictEqual(sinkB.emit.mock.callCount(), 2);

    assert.deepStrictEqual(sinkA.emit.mock.calls[0]!.arguments[0], {
      level: 'warning',
      message: 'warn-msg',
      source: 'w-source',
    });
    assert.deepStrictEqual(sinkA.emit.mock.calls[1]!.arguments[0], {
      level: 'error',
      message: 'err-msg',
      source: 'e-source',
    });
  });
});

describe('sessionLogDiagnosticSink', () => {
  it('logs both warning and error diagnostics through logWarning with explicit source', () => {
    const logWarning = mock.fn();
    const sink = sessionLogDiagnosticSink(() => ({ logWarning }) as unknown as SessionLogger);

    sink.emit({ level: 'warning', message: 'watch out', source: 'hook-error' });
    sink.emit({ level: 'error', message: 'boom', source: 'hook-crash' });

    assert.deepStrictEqual(logWarning.mock.calls[0]!.arguments, ['hook-error', 'watch out']);
    assert.deepStrictEqual(logWarning.mock.calls[1]!.arguments, ['hook-crash', 'boom']);
  });

  it('uses diagnostic:<level> as fallback source when source is omitted', () => {
    const logWarning = mock.fn();
    const sink = sessionLogDiagnosticSink(() => ({ logWarning }) as unknown as SessionLogger);

    sink.emit({ level: 'warning', message: 'warn-no-source' });
    sink.emit({ level: 'error', message: 'err-no-source' });

    assert.deepStrictEqual(logWarning.mock.calls[0]!.arguments, [
      'diagnostic:warning',
      'warn-no-source',
    ]);
    assert.deepStrictEqual(logWarning.mock.calls[1]!.arguments, [
      'diagnostic:error',
      'err-no-source',
    ]);
  });

  it('is a no-op when there is no active logger', () => {
    const sink = sessionLogDiagnosticSink(() => undefined);
    assert.doesNotThrow(() => sink.emit({ level: 'warning', message: 'ignored' }));
  });
});

describe('tuiDiagnosticSink', () => {
  it('maps warning -> warn and error -> danger', () => {
    const addNotice = mock.fn();
    const sink = tuiDiagnosticSink(addNotice);

    sink.emit({ level: 'warning', message: 'w' });
    sink.emit({ level: 'error', message: 'e' });

    assert.deepStrictEqual(addNotice.mock.calls[0]!.arguments, ['warn', 'w']);
    assert.deepStrictEqual(addNotice.mock.calls[1]!.arguments, ['danger', 'e']);
  });
});

describe('stderrDiagnosticSink', () => {
  it('writes plain messages as lines', () => {
    const seen: string[] = [];
    const sink = stderrDiagnosticSink(line => seen.push(line));

    sink.emit({ level: 'warning', message: 'first' });
    sink.emit({ level: 'error', message: 'second' });

    assert.deepStrictEqual(seen, ['first', 'second']);
  });
});
