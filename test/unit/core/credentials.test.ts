import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  addKey,
  deleteKey,
  describeKey,
  getKey,
  keyFingerprint,
  listKeys,
  migrateLegacyKeys,
  selectNextKey,
} from '../../../src/core/auth/credentials.js';
import type { ProviderKey } from '../../../src/core/config/types.js';
import { loadGlobalConfig, saveGlobalConfig } from '../../../src/core/config/index.js';

async function withGlobalHome(fn: (home: string) => Promise<void>): Promise<void> {
  const prev = process.env.XDG_CONFIG_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-creds-'));
  process.env.XDG_CONFIG_HOME = home;
  try {
    await fn(home);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    await fs.rm(home, { recursive: true, force: true });
  }
}

describe('keyFingerprint', () => {
  it('returns the last 4 chars of a long token', () => {
    assert.strictEqual(keyFingerprint('sk-ant-abcdef-1f2a'), '1f2a');
  });

  it('returns the whole token when it is 4 chars or shorter', () => {
    assert.strictEqual(keyFingerprint('abc'), 'abc');
    assert.strictEqual(keyFingerprint('abcd'), 'abcd');
  });

  it('returns the last 4 code units, even for non-ASCII tokens', () => {
    // Trailing 4 BMP chars — keys are usually ASCII but the helper
    // shouldn't mis-handle a stray unicode in the middle.
    assert.strictEqual(keyFingerprint('🚀wxyz1234'), '1234');
    // Leading-only ASCII variant.
    assert.strictEqual(keyFingerprint('1234abcd-εφγη'), 'εφγη');
  });
});

describe('describeKey', () => {
  it('renders label and last-4 when label is set', () => {
    const key = { id: 'x', token: 'tok-1234', createdAt: new Date(0).toISOString(), label: 'work' };
    assert.strictEqual(describeKey(key), 'work · …1234');
  });

  it('renders just last-4 when label is omitted', () => {
    const key = { id: 'x', token: 'tok-1234', createdAt: new Date(0).toISOString() };
    assert.strictEqual(describeKey(key), '…1234');
  });
});

describe('listKeys (legacy fallback)', () => {
  it('returns synthetic legacy entry when only the *Token field is set', () => {
    const cfg = { anthropicToken: 'sk-ant-abcd' };
    const keys = listKeys(cfg, 'anthropic');
    assert.strictEqual(keys.length, 1);
    assert.strictEqual(keys[0].id, 'legacy');
    assert.strictEqual(keys[0].token, 'sk-ant-abcd');
    assert.strictEqual(keys[0].label, 'default');
  });

  it('attaches the workersAi accountId as extras on the synthetic legacy entry', () => {
    const cfg = { workersAiToken: 'wai-tok', workersAiAccountId: 'acct-123' };
    const keys = listKeys(cfg, 'workersai');
    assert.strictEqual(keys.length, 1);
    assert.deepStrictEqual(keys[0].extras, { accountId: 'acct-123' });
  });

  it('returns the persisted keys when populated, ignoring legacy field', () => {
    const cfg = {
      anthropicToken: 'sk-ant-old',
      keys: { anthropic: [{ id: 'a', token: 'sk-ant-new', createdAt: 'now' }] },
    };
    const keys = listKeys(cfg, 'anthropic');
    assert.strictEqual(keys.length, 1);
    assert.strictEqual(keys[0].token, 'sk-ant-new');
  });

  it('returns empty when there is no legacy field and no stored keys', () => {
    assert.deepStrictEqual(listKeys({}, 'anthropic'), []);
  });
});

describe('getKey', () => {
  const cfg = {
    keys: {
      anthropic: [
        { id: 'a', token: 'tok-a', createdAt: 'now' },
        { id: 'b', token: 'tok-b', createdAt: 'now' },
      ],
    },
  };

  it('returns the first entry when id is omitted', () => {
    assert.strictEqual(getKey(cfg, 'anthropic')?.id, 'a');
  });

  it('returns the matched entry by id', () => {
    assert.strictEqual(getKey(cfg, 'anthropic', 'b')?.id, 'b');
  });

  it('returns undefined when id does not match', () => {
    assert.strictEqual(getKey(cfg, 'anthropic', 'gone'), undefined);
  });
});

describe('selectNextKey', () => {
  const mk = (id: string, createdAt: string): ProviderKey => ({
    id,
    token: `tok-${id}`,
    createdAt,
  });
  const a = mk('a', '2024-01-01T00:00:00Z');
  const b = mk('b', '2024-02-01T00:00:00Z');
  const c = mk('c', '2024-03-01T00:00:00Z');

  it('returns the first never-tried key, ordered by createdAt', () => {
    const next = selectNextKey([c, b, a], new Set());
    assert.strictEqual(next?.id, 'a');
  });

  it('skips tried keys', () => {
    const next = selectNextKey([a, b, c], new Set(['a']));
    assert.strictEqual(next?.id, 'b');
  });

  it('returns undefined when all keys are tried', () => {
    const next = selectNextKey([a, b], new Set(['a', 'b']));
    assert.strictEqual(next, undefined);
  });

  it('deprioritises recently-failed keys but still returns them when fresh pool is empty', () => {
    const now = 1_000_000;
    const failureLog = new Map([['a', now - 1000]]); // failed 1s ago
    // Only `a` is in the pool; even though it's recent, return it.
    const next = selectNextKey([a], new Set(), { failureLog, now });
    assert.strictEqual(next?.id, 'a');
  });

  it('prefers fresh over stale keys when both are available', () => {
    const now = 1_000_000;
    // `a` failed recently; `b` failed long ago; `c` never failed.
    const failureLog = new Map([
      ['a', now - 1000], // fresh failure
      ['b', now - 24 * 3600 * 1000], // very stale, treated as fresh
    ]);
    const next = selectNextKey([a, b, c], new Set(), { failureLog, now });
    // c (never failed) wins, then b (stale failure), then a.
    // Within fresh bucket, sorted by createdAt: b first (Feb), then c (Mar).
    // But `b`'s failure is older than the 5-min window so it's "fresh".
    assert.strictEqual(next?.id, 'b');
  });

  it('prefers a cache-warm key as a soft tiebreaker among healthy keys', () => {
    // Both keys are healthy (no failures). `b` was warmed more recently.
    const warmthLog = new Map([['b', 1_000_000]]);
    const next = selectNextKey([a, b], new Set(), { warmthLog });
    assert.strictEqual(next?.id, 'b');
  });

  it('breaks warmth ties on most-recent cache read', () => {
    const warmthLog = new Map([
      ['a', 1_000_000],
      ['b', 1_500_000], // warmer
      ['c', 800_000],
    ]);
    const next = selectNextKey([a, b, c], new Set(), { warmthLog });
    assert.strictEqual(next?.id, 'b');
  });

  it('does not promote a warm-but-failed key over a cold-and-healthy key (correctness wins)', () => {
    const now = 1_000_000;
    const failureLog = new Map([['b', now - 1000]]); // b just failed
    const warmthLog = new Map([['b', now - 100]]); // but b is also warm
    const next = selectNextKey([a, b], new Set(), { failureLog, warmthLog, now });
    // Stale-but-warm `b` must NOT beat fresh-but-cold `a`.
    assert.strictEqual(next?.id, 'a');
  });

  it('falls through to a warm stale key when no fresh keys are eligible', () => {
    const now = 1_000_000;
    const failureLog = new Map([
      ['a', now - 1000],
      ['b', now - 1000],
    ]);
    const warmthLog = new Map([['b', now - 100]]);
    const next = selectNextKey([a, b], new Set(), { failureLog, warmthLog, now });
    // Both stale; warmth tiebreaker promotes b.
    assert.strictEqual(next?.id, 'b');
  });

  it('preserves createdAt order when warmthLog is empty', () => {
    const next = selectNextKey([c, b, a], new Set(), { warmthLog: new Map() });
    assert.strictEqual(next?.id, 'a');
  });
});

describe('migrateLegacyKeys', () => {
  it('synthesises real entries for providers with only legacy *Token', () => {
    const cfg = { anthropicToken: 'sk-ant-1', groqToken: 'gsk_2' };
    const { changed, next } = migrateLegacyKeys(cfg);
    assert.strictEqual(changed, true);
    assert.strictEqual(next.keys?.anthropic?.length, 1);
    assert.strictEqual(next.keys?.anthropic?.[0]?.token, 'sk-ant-1');
    assert.strictEqual(next.keys?.anthropic?.[0]?.label, 'default');
    assert.match(next.keys?.anthropic?.[0]?.id ?? '', /^[0-9a-f-]{36}$/);
    assert.strictEqual(next.keys?.groq?.[0]?.token, 'gsk_2');
    // Legacy field is left in place for downgrade safety.
    assert.strictEqual(next.anthropicToken, 'sk-ant-1');
  });

  it('attaches workersAi accountId as extras', () => {
    const cfg = { workersAiToken: 'wai', workersAiAccountId: 'acct' };
    const { next } = migrateLegacyKeys(cfg);
    assert.deepStrictEqual(next.keys?.workersai?.[0]?.extras, { accountId: 'acct' });
  });

  it('is a no-op when keys are already populated', () => {
    const cfg = {
      anthropicToken: 'sk-ant-1',
      keys: { anthropic: [{ id: 'a', token: 'sk-ant-existing', createdAt: 'now' }] },
    };
    const { changed } = migrateLegacyKeys(cfg);
    assert.strictEqual(changed, false);
  });

  it('is a no-op when there is nothing to migrate', () => {
    const { changed } = migrateLegacyKeys({});
    assert.strictEqual(changed, false);
  });
});

describe('addKey / deleteKey roundtrip', () => {
  it('appends entries to the global config and surfaces them via listKeys', async () => {
    await withGlobalHome(async () => {
      const a = await addKey('anthropic', 'sk-ant-aaaa', { label: 'work' });
      const b = await addKey('anthropic', 'sk-ant-bbbb', { label: 'personal' });

      const cfg = await loadGlobalConfig();
      assert.strictEqual(cfg.keys?.anthropic?.length, 2);
      assert.strictEqual(cfg.keys?.anthropic?.[0]?.id, a.id);
      assert.strictEqual(cfg.keys?.anthropic?.[1]?.id, b.id);
      assert.strictEqual(cfg.keys?.anthropic?.[0]?.label, 'work');
      assert.notStrictEqual(a.id, b.id);
    });
  });

  it('removes a key by id and is a no-op for unknown ids', async () => {
    await withGlobalHome(async () => {
      const a = await addKey('groq', 'gsk_1');
      const b = await addKey('groq', 'gsk_2');

      await deleteKey('groq', a.id);
      let cfg = await loadGlobalConfig();
      assert.strictEqual(cfg.keys?.groq?.length, 1);
      assert.strictEqual(cfg.keys?.groq?.[0]?.id, b.id);

      await deleteKey('groq', 'no-such-id');
      cfg = await loadGlobalConfig();
      assert.strictEqual(cfg.keys?.groq?.length, 1);
    });
  });
});

describe('loadGlobalConfig migration', () => {
  it('rewrites the config on first load, baking the synthetic legacy entry in', async () => {
    await withGlobalHome(async () => {
      // Seed a legacy-only config — only the *Token field is set.
      await saveGlobalConfig({ anthropicToken: 'sk-ant-legacy' });

      // Explicitly verify the on-disk shape doesn't yet have `keys`. (The
      // saveGlobalConfig call above doesn't itself trigger migration —
      // migration runs from loadGlobalConfig.)
      const cfg1 = await loadGlobalConfig();
      assert.strictEqual(cfg1.anthropicToken, 'sk-ant-legacy');
      assert.strictEqual(cfg1.keys?.anthropic?.length, 1);
      assert.strictEqual(cfg1.keys?.anthropic?.[0]?.token, 'sk-ant-legacy');

      // Second load: the migration is now persisted, so the in-memory
      // shape should match the on-disk shape exactly.
      const cfg2 = await loadGlobalConfig();
      assert.strictEqual(cfg2.keys?.anthropic?.length, 1);
      // The id should be stable (same uuid as the first load wrote) since
      // migration is idempotent once keys are populated.
      assert.strictEqual(cfg2.keys?.anthropic?.[0]?.id, cfg1.keys?.anthropic?.[0]?.id);
    });
  });
});
