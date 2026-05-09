import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  createSessionLogger,
  sessionsDir,
  appendProviderLog,
  getLastSessionSelection,
  getRecentSessions,
  loadHistoryFromSessions,
} from '../../../../src/core/session/session-log.js';

let originalHome: string | undefined;
let homeDir: string;

before(() => {
  originalHome = process.env.HOME;
});

after(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

beforeEach(() => {
  homeDir = path.join(os.tmpdir(), `oc-sessionlog-${crypto.randomUUID()}`);
  fs.mkdirSync(homeDir, { recursive: true });
  process.env.HOME = homeDir;
});

function logsDir(): string {
  return path.join(homeDir, '.factory', 'sessions');
}

function writeSessionLog(name: string, lines: object[], mtime?: Date): string {
  fs.mkdirSync(logsDir(), { recursive: true });
  const file = path.join(logsDir(), `${name}.jsonl`);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  if (mtime) {
    fs.utimesSync(file, mtime, mtime);
  }
  return file;
}

async function flushNextTick(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

describe('sessionsDir', () => {
  it('returns ~/.factory/sessions under the current HOME', () => {
    assert.strictEqual(sessionsDir(), path.join(homeDir, '.factory', 'sessions'));
  });
});

describe('createSessionLogger', () => {
  it('creates the sessions directory and a fresh .jsonl file', () => {
    const logger = createSessionLogger();
    try {
      assert.ok(fs.existsSync(logsDir()), 'sessions dir should exist');
      assert.ok(fs.existsSync(logger.filePath), 'log file should exist');
      assert.ok(logger.filePath.endsWith('.jsonl'));
    } finally {
      logger.close();
    }
  });

  it('writes session-start, user-input, agent-event, model-change, and session-end as JSONL', async () => {
    const logger = createSessionLogger();
    try {
      logger.logSessionStart({
        provider: 'ollama',
        model: 'llama3:latest',
        cwd: '/x',
      });
      logger.logUserInput('hello');
      logger.logAgentEvent({ type: 'agent-text', text: 'hi back' } as never);
      logger.logModelChange('llama3:latest', 'llama3.1:latest', 'key-1');
      logger.logCommand('rotate', 'next');
      logger.logSystemPrompt('you are a bot');
      logger.logSystemPromptChange('plan-mode-toggled');
      logger.logPermissionChange('allow', 'Bash');
      logger.logStuckPattern(3);
      logger.logWarning('cache', 'evicted entry');
      logger.logGitChange({ dirty: false }, { branch: 'main', dirty: true });
      logger.logProviderAuth({ provider: 'ollama', action: 'probe', outcome: 'success' });
      logger.logSessionEnd();
    } finally {
      await flushNextTick();
      logger.close();
    }

    const raw = fs.readFileSync(logger.filePath, 'utf-8');
    const events = raw
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
    const types = events.map(e => e.type);
    assert.deepStrictEqual(types, [
      'session-start',
      'user-input',
      'agent-event',
      'model-change',
      'command',
      'system-prompt',
      'system-prompt-change',
      'permission-change',
      'stuck-pattern',
      'warning',
      'git-change',
      'provider-auth',
      'session-end',
    ]);
    // Each entry has a UTC timestamp prefix.
    for (const e of events) {
      assert.match(e.ts as string, /^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('strips function fields from permission-request events on serialize', async () => {
    const logger = createSessionLogger();
    try {
      logger.logAgentEvent({
        type: 'permission-request',
        toolName: 'Bash',
        respond: () => undefined,
      } as never);
    } finally {
      await flushNextTick();
      logger.close();
    }
    const raw = fs.readFileSync(logger.filePath, 'utf-8');
    const event = JSON.parse(raw.trim());
    assert.strictEqual(event.event.type, 'permission-request');
    assert.strictEqual(event.event.toolName, 'Bash');
    assert.ok(!('respond' in event.event), 'respond function should be stripped');
  });

  it('serializes Error objects in agent-event errors as { message, stack }', async () => {
    const logger = createSessionLogger();
    try {
      const err = new Error('boom');
      logger.logAgentEvent({ type: 'error', error: err } as never);
    } finally {
      await flushNextTick();
      logger.close();
    }
    const raw = fs.readFileSync(logger.filePath, 'utf-8');
    const event = JSON.parse(raw.trim());
    assert.strictEqual(event.event.error.message, 'boom');
    assert.ok(typeof event.event.error.stack === 'string');
  });

  it('close() drains queued writes before closing the fd', async () => {
    const logger = createSessionLogger();
    logger.logUserInput('queued');
    logger.close();
    const raw = fs.readFileSync(logger.filePath, 'utf-8');
    assert.ok(raw.includes('"queued"'), 'queued message must be flushed by close()');
  });

  it('further writes after close() are silently dropped', async () => {
    const logger = createSessionLogger();
    logger.logUserInput('before');
    logger.close();
    logger.logUserInput('after');
    await flushNextTick();
    const raw = fs.readFileSync(logger.filePath, 'utf-8');
    assert.ok(raw.includes('"before"'));
    assert.ok(!raw.includes('"after"'), 'writes after close must not land on disk');
  });

  it('omits keyId in model-change when not provided', async () => {
    const logger = createSessionLogger();
    logger.logModelChange('a', 'b');
    logger.close();
    const raw = fs.readFileSync(logger.filePath, 'utf-8');
    const event = JSON.parse(raw.trim());
    assert.strictEqual(event.from, 'a');
    assert.strictEqual(event.to, 'b');
    assert.ok(!('keyId' in event));
  });

  it('writes providerAfter when switching backends mid-session', async () => {
    const logger = createSessionLogger();
    logger.logModelChange('claude-sonnet-4-6', 'gpt-4.1', 'k1', 'openai');
    logger.close();
    const raw = fs.readFileSync(logger.filePath, 'utf-8');
    const event = JSON.parse(raw.trim());
    assert.strictEqual(event.providerAfter, 'openai');
  });
});

describe('appendProviderLog', () => {
  it('appends a JSONL entry to ~/.factory/provider-events.jsonl, creating dirs', () => {
    appendProviderLog({
      provider: 'anthropic',
      category: 'auth',
      action: 'token-saved',
      outcome: 'success',
      detail: 'via env var',
    });
    appendProviderLog({
      provider: 'ollama',
      category: 'startup',
      action: 'probe',
      detail: 'connection refused',
    });
    const filePath = path.join(homeDir, '.factory', 'provider-events.jsonl');
    const raw = fs.readFileSync(filePath, 'utf-8');
    const events = raw
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].provider, 'anthropic');
    assert.strictEqual(events[0].action, 'token-saved');
    assert.strictEqual(events[1].provider, 'ollama');
    assert.match(events[0].ts as string, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('does not throw when the home directory is not writable', () => {
    // Point HOME at a path that exists as a file (so mkdirSync would EEXIST/EISDIR
    // when targeting a subdir under it). The function must swallow the error.
    const fileAsHome = path.join(os.tmpdir(), `oc-sessionlog-readonly-${crypto.randomUUID()}`);
    fs.writeFileSync(fileAsHome, '');
    process.env.HOME = fileAsHome;
    try {
      assert.doesNotThrow(() =>
        appendProviderLog({
          provider: 'x',
          category: 'auth',
          action: 'y',
          detail: 'z',
        }),
      );
    } finally {
      fs.unlinkSync(fileAsHome);
    }
  });
});

describe('getLastSessionSelection', () => {
  it('returns null when no session logs exist', async () => {
    const result = await getLastSessionSelection();
    assert.strictEqual(result, null);
  });

  it('returns the provider/model from the newest session-start when no model-change followed', async () => {
    writeSessionLog(
      '2026-05-08T10-00-00-000Z-aaa',
      [{ type: 'session-start', provider: 'ollama', model: 'llama3:latest', cwd: '/x' }],
      new Date('2026-05-08T10:00:00Z'),
    );
    const result = await getLastSessionSelection();
    assert.deepStrictEqual(result, { provider: 'ollama', model: 'llama3:latest' });
  });

  it('uses providerAfter from model-change as the final provider', async () => {
    writeSessionLog(
      '2026-05-08T14-00-00-000Z-ddd',
      [
        {
          type: 'session-start',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          cwd: '/x',
          keyId: 'k1',
        },
        {
          type: 'model-change',
          from: 'claude-sonnet-4-6',
          to: 'gpt-4.1',
          keyId: 'k2',
          providerAfter: 'openai',
        },
      ],
      new Date('2026-05-08T14:00:00Z'),
    );
    const result = await getLastSessionSelection();
    assert.deepStrictEqual(result, {
      provider: 'openai',
      model: 'gpt-4.1',
      keyId: 'k2',
    });
  });

  it('returns the latest model-change as the final model + keyId', async () => {
    writeSessionLog(
      '2026-05-08T11-00-00-000Z-bbb',
      [
        {
          type: 'session-start',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          cwd: '/x',
          keyId: 'first-key',
        },
        {
          type: 'model-change',
          from: 'claude-sonnet-4-6',
          to: 'claude-opus-4-7',
          keyId: 'second-key',
        },
      ],
      new Date('2026-05-08T11:00:00Z'),
    );
    const result = await getLastSessionSelection();
    assert.deepStrictEqual(result, {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      keyId: 'second-key',
    });
  });

  it('skips <startup> placeholder model-change entries', async () => {
    writeSessionLog(
      '2026-05-08T12-00-00-000Z-ccc',
      [
        { type: 'session-start', provider: 'ollama', model: 'llama3:latest', cwd: '/x' },
        { type: 'model-change', from: 'llama3:latest', to: '<startup>' },
      ],
      new Date('2026-05-08T12:00:00Z'),
    );
    const result = await getLastSessionSelection();
    assert.deepStrictEqual(result, { provider: 'ollama', model: 'llama3:latest' });
  });

  it('returns null when the newest log is empty or malformed', async () => {
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.writeFileSync(path.join(logsDir(), 'empty.jsonl'), '');
    const result = await getLastSessionSelection();
    assert.strictEqual(result, null);
  });

  it('reads only the newest session log (by mtime)', async () => {
    writeSessionLog(
      'older.jsonl-prefix',
      [{ type: 'session-start', provider: 'ollama', model: 'llama3:latest', cwd: '/x' }],
      new Date('2026-01-01T00:00:00Z'),
    );
    writeSessionLog(
      'newer.jsonl-prefix',
      [{ type: 'session-start', provider: 'anthropic', model: 'claude-sonnet-4-6', cwd: '/x' }],
      new Date('2026-05-08T00:00:00Z'),
    );
    const result = await getLastSessionSelection();
    assert.strictEqual(result?.provider, 'anthropic');
  });
});

describe('getRecentSessions', () => {
  it('returns [] when no sessions exist', async () => {
    const result = await getRecentSessions();
    assert.deepStrictEqual(result, []);
  });

  it('skips sessions with no user-input events (abandoned probes)', async () => {
    writeSessionLog(
      'abandoned',
      [
        {
          type: 'session-start',
          provider: 'ollama',
          model: 'llama3:latest',
          cwd: '/x',
          ts: '2026-05-08T10:00:00Z',
        },
      ],
      new Date('2026-05-08T10:00:00Z'),
    );
    const result = await getRecentSessions();
    assert.strictEqual(result.length, 0);
  });

  it('deduplicates by provider+model — only the newest survives', async () => {
    writeSessionLog(
      'older',
      [
        {
          type: 'session-start',
          provider: 'ollama',
          model: 'llama3:latest',
          cwd: '/x',
          ts: '2026-05-01T10:00:00Z',
        },
        { type: 'user-input', content: 'hi' },
      ],
      new Date('2026-05-01T10:00:00Z'),
    );
    writeSessionLog(
      'newer',
      [
        {
          type: 'session-start',
          provider: 'ollama',
          model: 'llama3:latest',
          cwd: '/x',
          ts: '2026-05-08T10:00:00Z',
        },
        { type: 'user-input', content: 'hello' },
      ],
      new Date('2026-05-08T10:00:00Z'),
    );
    const result = await getRecentSessions();
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].startedAt, '2026-05-08T10:00:00Z');
  });

  it('classifies the latest error event as throttle / quota / permission / generic', async () => {
    const cases = [
      { msg: 'HTTP 429 rate limit exceeded', expect: 'throttle' as const },
      { msg: 'You have insufficient credits', expect: 'quota' as const },
      { msg: 'unauthorized: invalid api key', expect: 'permission' as const },
      { msg: 'connection reset by peer', expect: 'error' as const },
    ];
    let i = 0;
    for (const { msg } of cases) {
      writeSessionLog(
        `case-${i}`,
        [
          {
            type: 'session-start',
            provider: 'p',
            model: `m${i}`,
            cwd: '/x',
            ts: `2026-05-0${i + 1}T10:00:00Z`,
          },
          { type: 'user-input', content: 'hi' },
          {
            type: 'agent-event',
            event: { type: 'error', error: { message: msg } },
          },
        ],
        new Date(`2026-05-0${i + 1}T10:00:00Z`),
      );
      i++;
    }
    const sessions = await getRecentSessions();
    const byModel = new Map(sessions.map(s => [s.model, s.status]));
    assert.strictEqual(byModel.get('m0'), 'throttle');
    assert.strictEqual(byModel.get('m1'), 'quota');
    assert.strictEqual(byModel.get('m2'), 'permission');
    assert.strictEqual(byModel.get('m3'), 'error');
  });

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      writeSessionLog(
        `s-${i}`,
        [
          {
            type: 'session-start',
            provider: 'p',
            model: `m${i}`,
            cwd: '/x',
            ts: `2026-05-0${i + 1}T10:00:00Z`,
          },
          { type: 'user-input', content: 'hi' },
        ],
        new Date(`2026-05-0${i + 1}T10:00:00Z`),
      );
    }
    const result = await getRecentSessions(2);
    assert.strictEqual(result.length, 2);
  });

  it('updates model + keyId from the latest model-change entry', async () => {
    writeSessionLog(
      'switched',
      [
        {
          type: 'session-start',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          cwd: '/x',
          ts: '2026-05-08T10:00:00Z',
          keyId: 'k1',
        },
        { type: 'user-input', content: 'hi' },
        { type: 'model-change', from: 'claude-sonnet-4-6', to: 'claude-opus-4-7', keyId: 'k2' },
      ],
      new Date('2026-05-08T10:00:00Z'),
    );
    const [session] = await getRecentSessions();
    assert.strictEqual(session.model, 'claude-opus-4-7');
    assert.strictEqual(session.keyId, 'k2');
  });

  it('updates provider from providerAfter when switching with /provider', async () => {
    writeSessionLog(
      'provider-switch',
      [
        {
          type: 'session-start',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          cwd: '/x',
          ts: '2026-05-08T11:00:00Z',
        },
        { type: 'user-input', content: 'hi' },
        {
          type: 'model-change',
          from: 'claude-sonnet-4-6',
          to: 'gpt-4.1',
          providerAfter: 'openai',
        },
      ],
      new Date('2026-05-08T11:00:00Z'),
    );
    const [session] = await getRecentSessions();
    assert.strictEqual(session.provider, 'openai');
    assert.strictEqual(session.model, 'gpt-4.1');
  });
});

describe('loadHistoryFromSessions', () => {
  it('returns [] when no sessions exist', async () => {
    const result = await loadHistoryFromSessions();
    assert.deepStrictEqual(result, []);
  });

  it('returns user inputs newest-first within each session, dedupes consecutive duplicates', async () => {
    writeSessionLog(
      'history',
      [
        { type: 'session-start', provider: 'p', model: 'm', cwd: '/x' },
        { type: 'user-input', content: 'first' },
        { type: 'user-input', content: 'second' },
        { type: 'user-input', content: 'second' }, // dup, should collapse
        { type: 'user-input', content: 'third' },
      ],
      new Date('2026-05-08T10:00:00Z'),
    );
    const history = await loadHistoryFromSessions();
    // Newest within file first → reversed: third, second, first
    assert.deepStrictEqual(history, ['third', 'second', 'first']);
  });

  it('respects the limit', async () => {
    writeSessionLog(
      'h',
      [
        { type: 'session-start', provider: 'p', model: 'm', cwd: '/x' },
        ...Array.from({ length: 10 }, (_, i) => ({ type: 'user-input', content: `m${i}` })),
      ],
      new Date('2026-05-08T10:00:00Z'),
    );
    const history = await loadHistoryFromSessions(3);
    assert.strictEqual(history.length, 3);
  });

  it('skips malformed JSONL lines gracefully', async () => {
    fs.mkdirSync(logsDir(), { recursive: true });
    const file = path.join(logsDir(), 'broken.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session-start', provider: 'p', model: 'm', cwd: '/x' }),
        'not-json-at-all',
        JSON.stringify({ type: 'user-input', content: 'survives' }),
      ].join('\n') + '\n',
    );
    const history = await loadHistoryFromSessions();
    assert.deepStrictEqual(history, ['survives']);
  });
});
