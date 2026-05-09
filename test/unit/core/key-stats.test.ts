import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  flushKeyStats,
  getStats,
  getWarmthLog,
  listStatsForProvider,
  recordFailure,
  recordSuccess,
  recordTokenUsage,
  _resetKeyStatsForTests,
} from '../../../src/core/session/key-stats.js';

async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const prev = os.homedir;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-keystats-'));
  // os.homedir() is what key-stats reads — patch it for the test.
  (os as unknown as { homedir: () => string }).homedir = () => home;
  _resetKeyStatsForTests();
  try {
    await fn(home);
  } finally {
    (os as unknown as { homedir: () => string }).homedir = prev;
    _resetKeyStatsForTests();
    await fs.rm(home, { recursive: true, force: true });
  }
}

describe('key-stats', () => {
  beforeEach(_resetKeyStatsForTests);

  it('records a success and persists across cache reset', async () => {
    await withTempHome(async () => {
      await recordSuccess('anthropic', 'k1');
      await flushKeyStats();
      _resetKeyStatsForTests();
      const stat = await getStats('anthropic', 'k1');
      assert.strictEqual(stat?.successCount, 1);
      assert.ok(stat?.lastSuccessAt);
    });
  });

  it('separates rate-limit from auth failures', async () => {
    await withTempHome(async () => {
      await recordFailure('anthropic', 'k1', 'rate-limit');
      await recordFailure('anthropic', 'k1', 'rate-limit');
      await recordFailure('anthropic', 'k1', 'auth');
      await flushKeyStats();

      const stat = await getStats('anthropic', 'k1');
      assert.strictEqual(stat?.rateLimitCount, 2);
      assert.strictEqual(stat?.authErrorCount, 1);
      assert.ok(stat?.lastFailureAt);
    });
  });

  it('keeps stats for different keys independent', async () => {
    await withTempHome(async () => {
      await recordSuccess('anthropic', 'k1');
      await recordFailure('anthropic', 'k2', 'rate-limit');
      await flushKeyStats();

      const all = await listStatsForProvider('anthropic');
      assert.strictEqual(all.k1?.successCount, 1);
      assert.strictEqual(all.k1?.rateLimitCount, 0);
      assert.strictEqual(all.k2?.successCount, 0);
      assert.strictEqual(all.k2?.rateLimitCount, 1);
    });
  });

  it('returns undefined for an unknown key', async () => {
    await withTempHome(async () => {
      const stat = await getStats('anthropic', 'unknown');
      assert.strictEqual(stat, undefined);
    });
  });

  it('returns an empty map for an unknown provider', async () => {
    await withTempHome(async () => {
      const all = await listStatsForProvider('nonexistent');
      assert.deepStrictEqual(all, {});
    });
  });

  it('accumulates cached vs uncached input tokens across turns', async () => {
    await withTempHome(async () => {
      await recordTokenUsage('anthropic', 'k1', {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedPromptTokens: 80,
        cacheCreationTokens: 10,
      });
      await recordTokenUsage('anthropic', 'k1', {
        promptTokens: 50,
        completionTokens: 10,
        totalTokens: 60,
        cachedPromptTokens: 50,
      });
      await flushKeyStats();
      _resetKeyStatsForTests();

      const stat = await getStats('anthropic', 'k1');
      // 80 + 50 cached
      assert.strictEqual(stat?.cachedInputTokens, 130);
      // (100 - 80) + (50 - 50) = 20 fresh
      assert.strictEqual(stat?.uncachedInputTokens, 20);
      // 10 + 0 creation
      assert.strictEqual(stat?.cacheCreationTokens, 10);
      assert.ok(stat?.lastCacheReadAt);
    });
  });

  it('does not stamp lastCacheReadAt when cached tokens are zero', async () => {
    await withTempHome(async () => {
      await recordTokenUsage('anthropic', 'k1', {
        promptTokens: 40,
        completionTokens: 10,
        totalTokens: 50,
      });
      await flushKeyStats();

      const stat = await getStats('anthropic', 'k1');
      assert.strictEqual(stat?.cachedInputTokens, 0);
      assert.strictEqual(stat?.uncachedInputTokens, 40);
      assert.strictEqual(stat?.lastCacheReadAt, undefined);
    });
  });

  it('treats cached > prompt as zero uncached (does not go negative)', async () => {
    await withTempHome(async () => {
      // Defensive: providers should never report cached > prompt, but if they
      // do, uncached must clamp to 0 instead of subtracting into negatives.
      await recordTokenUsage('anthropic', 'k1', {
        promptTokens: 50,
        completionTokens: 5,
        totalTokens: 55,
        cachedPromptTokens: 100,
      });
      await flushKeyStats();

      const stat = await getStats('anthropic', 'k1');
      assert.strictEqual(stat?.uncachedInputTokens, 0);
    });
  });

  it('getWarmthLog returns recent cache reads within the TTL window', async () => {
    await withTempHome(async () => {
      // k1 reads cache (lastCacheReadAt stamped now); k2 has no cache reads.
      await recordTokenUsage('anthropic', 'k1', {
        promptTokens: 100,
        completionTokens: 10,
        totalTokens: 110,
        cachedPromptTokens: 80,
      });
      await recordTokenUsage('anthropic', 'k2', {
        promptTokens: 100,
        completionTokens: 10,
        totalTokens: 110,
      });
      await flushKeyStats();

      const log = await getWarmthLog('anthropic', 5 * 60 * 1000);
      assert.strictEqual(log.has('k1'), true, 'k1 should be in the warmth log');
      assert.strictEqual(log.has('k2'), false, 'k2 has no cache reads');
      const k1 = log.get('k1');
      assert.ok(k1 !== undefined && Date.now() - k1 < 5 * 60 * 1000);
    });
  });

  it('getWarmthLog excludes cache reads older than the TTL window', async () => {
    await withTempHome(async () => {
      await recordTokenUsage('anthropic', 'k1', {
        promptTokens: 100,
        completionTokens: 10,
        totalTokens: 110,
        cachedPromptTokens: 80,
      });
      await flushKeyStats();
      // Use a 1ms window — k1's read just happened so the entry is brand-new.
      // Wait a couple ms to make sure it falls outside.
      await new Promise(r => setTimeout(r, 5));
      const log = await getWarmthLog('anthropic', 1);
      assert.strictEqual(log.size, 0);
    });
  });

  it('getWarmthLog returns an empty map for unknown providers', async () => {
    await withTempHome(async () => {
      const log = await getWarmthLog('nonexistent', 5 * 60 * 1000);
      assert.strictEqual(log.size, 0);
    });
  });
});
