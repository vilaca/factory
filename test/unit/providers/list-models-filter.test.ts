import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { filterChatModels, matchedPattern } from '../../../src/providers/list-models-filter.js';

const LOG_PATH = path.join(os.homedir(), '.factory', 'provider-events.jsonl');

// Read every line written for a specific provider tag. Each test uses a
// uuid-tagged provider name so concurrent test files writing to the same
// shared log can't interfere with our assertions.
function readEventsFor(provider: string): unknown[] {
  if (!fs.existsSync(LOG_PATH)) return [];
  const lines = fs.readFileSync(LOG_PATH, 'utf-8').trim().split('\n');
  const events: unknown[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.provider === provider) events.push(parsed);
    } catch {
      // skip malformed
    }
  }
  return events;
}

describe('filterChatModels', () => {
  it('keeps items in input order and returns only those the predicate accepts', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const kept = filterChatModels(`test-${randomUUID()}`, items, item =>
      item.id === 'b' ? 'dropped because b' : true,
    );
    assert.deepStrictEqual(
      kept.map(k => k.id),
      ['a', 'c'],
    );
  });

  it('logs once per call when items are dropped, with provider, kept count, and reasons', () => {
    const tag = `test-${randomUUID()}`;
    const items = [{ id: 'keep' }, { id: 'drop1' }, { id: 'drop2' }];
    filterChatModels(tag, items, item =>
      item.id.startsWith('drop') ? `non-chat: ${item.id}` : true,
    );

    const events = readEventsFor(tag);
    assert.strictEqual(events.length, 1, 'expected exactly one log line for this tag');
    const event = events[0] as { category: string; action: string; detail: string };
    assert.strictEqual(event.category, 'diagnostic');
    assert.strictEqual(event.action, 'list-models-filter');
    const detail = JSON.parse(event.detail);
    assert.strictEqual(detail.kept, 1);
    assert.deepStrictEqual(detail.dropped, [
      { id: 'drop1', reason: 'non-chat: drop1' },
      { id: 'drop2', reason: 'non-chat: drop2' },
    ]);
  });

  it('does not log when nothing was dropped', () => {
    const tag = `test-${randomUUID()}`;
    filterChatModels(tag, [{ id: 'a' }, { id: 'b' }], () => true);
    assert.deepStrictEqual(readEventsFor(tag), []);
  });

  it('does not log on an empty input', () => {
    const tag = `test-${randomUUID()}`;
    filterChatModels(tag, [], () => true);
    assert.deepStrictEqual(readEventsFor(tag), []);
  });
});

describe('matchedPattern', () => {
  it('returns the first pattern that appears in the model id', () => {
    assert.strictEqual(matchedPattern('whisper-1', ['embed', 'whisper', 'tts']), 'whisper');
    assert.strictEqual(
      matchedPattern('text-embedding-3-large', ['embed', 'whisper', 'tts']),
      'embed',
    );
  });

  it('lowercases the input before matching', () => {
    assert.strictEqual(matchedPattern('Whisper-1', ['whisper']), 'whisper');
  });

  it('returns null when no pattern matches', () => {
    assert.strictEqual(matchedPattern('gpt-4o', ['embed', 'whisper', 'tts']), null);
  });
});
