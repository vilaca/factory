// Read-cache contract tests.
//
// The 5fcea6d bug was: the file cache fingerprinted (path, mtime, sha256)
// but didn't include (offset, limit). A partial Read seeded the cache,
// the next full-file Read got a "refer to your earlier Read" hit for
// lines the model never received, and the model hallucinated.
//
// The fix made `isPartialRead(args)` the gate on both reads-of-cache
// (tryReadCacheHit) and writes-to-cache (maintainFileCache). This file
// pins that gate at every edge of the partial/full boundary.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  isPartialRead,
  tryReadCacheHit,
  maintainFileCache,
} from '../../../../../src/core/agent/tool-calls/run-tool-calls-cache.js';
import { FileCache } from '../../../../../src/core/agent/cache/file-cache.js';
import { TOOL_NAMES } from '../../../../../src/tools/types.js';
import type { ToolCallMessage } from '../../../../../src/providers/types.js';
import type { ToolLoopContext } from '../../../../../src/core/agent/tool-calls/types.js';
import type { AgentEvent } from '../../../../../src/core/agent/types.js';

// ─── isPartialRead — direct boundary table ─────────────────────────────

describe('isPartialRead', () => {
  // The boolean output is the gate that decides whether the cache is
  // consulted / seeded. Every cell of the partial/full boundary is
  // tested here so a refactor of the helper can't silently shift the
  // gate (e.g. forgetting to special-case offset === 0).

  it('returns false for undefined args (no Read arguments at all)', () => {
    assert.equal(isPartialRead(undefined), false);
  });

  it('returns false for {} (full read, no offset / limit)', () => {
    assert.equal(isPartialRead({}), false);
  });

  it('returns false for { file_path } only (full read)', () => {
    assert.equal(isPartialRead({ file_path: '/tmp/x' }), false);
  });

  it('returns false for offset === 0 (full read from line 1)', () => {
    // offset=0 means "start at the top" which is the same byte range as
    // a no-offset read. The contract treats it as a full read.
    assert.equal(isPartialRead({ offset: 0 }), false);
  });

  it('returns true for any non-zero offset', () => {
    assert.equal(isPartialRead({ offset: 1 }), true);
    assert.equal(isPartialRead({ offset: 100 }), true);
    assert.equal(isPartialRead({ offset: -1 }), true);
  });

  it('returns true for any defined limit (even limit === 0)', () => {
    // limit=0 is degenerate but the model could send it; the contract
    // treats *any* explicit limit as a partial read.
    assert.equal(isPartialRead({ limit: 0 }), true);
    assert.equal(isPartialRead({ limit: 1 }), true);
    assert.equal(isPartialRead({ limit: 1000 }), true);
  });

  it('returns false for limit === null (model sent JSON null — equivalent to absent)', () => {
    assert.equal(isPartialRead({ limit: null }), false);
  });

  it('returns false for limit === undefined explicitly', () => {
    assert.equal(isPartialRead({ limit: undefined }), false);
  });

  it('returns true when offset is non-zero even with no limit', () => {
    assert.equal(isPartialRead({ file_path: '/tmp/x', offset: 5 }), true);
  });

  it('returns true when limit is set even with offset === 0', () => {
    assert.equal(isPartialRead({ file_path: '/tmp/x', offset: 0, limit: 10 }), true);
  });

  it('returns false for non-numeric offset (model sent garbage — treat as absent)', () => {
    // Defensive: a stringly-typed offset doesn't match the typeof check,
    // so it's ignored. The gate errs on the side of "treat as full" —
    // not a security concern because the *correctness* concern is the
    // opposite direction (caching a partial as full).
    assert.equal(isPartialRead({ offset: 'top' as unknown as number }), false);
  });
});

// ─── tryReadCacheHit + maintainFileCache integration ───────────────────

describe('Read cache contract (5fcea6d regression)', () => {
  let tmpdir: string;
  let filepath: string;
  let cache: FileCache;

  beforeEach(async () => {
    tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-cache-test-'));
    filepath = path.join(tmpdir, 'file.txt');
    await fs.writeFile(filepath, 'line 1\nline 2\nline 3\nline 4\nline 5\n');
    cache = new FileCache();
  });

  afterEach(async () => {
    await fs.rm(tmpdir, { recursive: true, force: true });
  });

  // Minimal ctx with only the fields the cache helpers touch.
  function makeCtx(): ToolLoopContext {
    const conversationMessages: Array<{ kind: string; text: string }> = [];
    return {
      fileCache: cache,
      useUserResultFraming: false,
      conversation: {
        addUser: (text: string) => conversationMessages.push({ kind: 'user', text }),
        addToolResult: (text: string) => conversationMessages.push({ kind: 'tool', text }),
      },
    } as unknown as ToolLoopContext;
  }

  function readCall(args: Record<string, unknown>): ToolCallMessage {
    return {
      id: 'call-1',
      type: 'function',
      function: { name: TOOL_NAMES.Read, arguments: args },
    } as unknown as ToolCallMessage;
  }

  async function drainGenerator(
    gen: AsyncGenerator<AgentEvent, boolean>,
  ): Promise<{ events: AgentEvent[]; result: boolean }> {
    const events: AgentEvent[] = [];
    let done: IteratorResult<AgentEvent, boolean>;
    do {
      done = await gen.next();
      if (!done.done) events.push(done.value);
    } while (!done.done);
    return { events, result: done.value };
  }

  describe('maintainFileCache', () => {
    it('records a full Read (no offset, no limit)', async () => {
      await maintainFileCache(readCall({ file_path: filepath }), cache);
      assert.ok(cache.get(filepath), 'cache should contain the file after a full Read');
    });

    it('records a Read with offset === 0 (treated as full)', async () => {
      await maintainFileCache(readCall({ file_path: filepath, offset: 0 }), cache);
      assert.ok(cache.get(filepath), 'offset=0 is a full read — cache should be seeded');
    });

    it('does NOT record a partial Read with non-zero offset (5fcea6d)', async () => {
      await maintainFileCache(readCall({ file_path: filepath, offset: 2 }), cache);
      assert.equal(cache.get(filepath), undefined, 'partial reads must not seed the cache');
    });

    it('does NOT record a partial Read with explicit limit (5fcea6d)', async () => {
      await maintainFileCache(readCall({ file_path: filepath, limit: 2 }), cache);
      assert.equal(cache.get(filepath), undefined, 'partial reads must not seed the cache');
    });

    it('does NOT record a partial Read with offset=0 + limit (still partial)', async () => {
      await maintainFileCache(readCall({ file_path: filepath, offset: 0, limit: 3 }), cache);
      assert.equal(cache.get(filepath), undefined, 'any explicit limit makes the read partial');
    });

    it('invalidates the cache on an Edit', async () => {
      // Seed the cache, then run an Edit — entry must be dropped so the
      // next Read re-stamps the (possibly changed) file.
      await maintainFileCache(readCall({ file_path: filepath }), cache);
      assert.ok(cache.get(filepath));
      const editCall: ToolCallMessage = {
        id: 'call-2',
        type: 'function',
        function: { name: TOOL_NAMES.Edit, arguments: { file_path: filepath } },
      } as unknown as ToolCallMessage;
      await maintainFileCache(editCall, cache);
      assert.equal(cache.get(filepath), undefined, 'Edit must invalidate the cache entry');
    });
  });

  describe('tryReadCacheHit', () => {
    it('returns a hit for a full Read when the file is unchanged', async () => {
      // Seed via a full Read first.
      await maintainFileCache(readCall({ file_path: filepath }), cache);
      // Now look it up.
      const { events, result } = await drainGenerator(
        tryReadCacheHit(readCall({ file_path: filepath }), makeCtx()),
      );
      assert.equal(result, true, 'unchanged file must produce a cache hit');
      assert.ok(
        events.some(e => e.type === 'read-cache-hit'),
        'should yield a read-cache-hit event',
      );
    });

    it('returns NO hit for a partial Read even when the file is unchanged (5fcea6d)', async () => {
      // Seed via a full Read so the cache HAS an entry for this file.
      await maintainFileCache(readCall({ file_path: filepath }), cache);
      assert.ok(cache.get(filepath), 'precondition: cache must have a full-read entry');

      // Now request a partial — must NOT short-circuit, because the
      // cached "unchanged" tells us nothing about the requested range.
      const { result } = await drainGenerator(
        tryReadCacheHit(readCall({ file_path: filepath, offset: 2 }), makeCtx()),
      );
      assert.equal(result, false, 'partial reads must bypass the cache');
    });

    it('returns NO hit for a partial Read with an explicit limit', async () => {
      await maintainFileCache(readCall({ file_path: filepath }), cache);
      const { result } = await drainGenerator(
        tryReadCacheHit(readCall({ file_path: filepath, limit: 2 }), makeCtx()),
      );
      assert.equal(result, false, 'partial reads (limit set) must bypass the cache');
    });

    it('returns NO hit when there is no cached entry (cold cache)', async () => {
      const { result } = await drainGenerator(
        tryReadCacheHit(readCall({ file_path: filepath }), makeCtx()),
      );
      assert.equal(result, false);
    });

    it('returns NO hit when the file has changed (mtime + content differ)', async () => {
      await maintainFileCache(readCall({ file_path: filepath }), cache);
      // Sleep briefly to ensure mtime moves on filesystems with low
      // resolution, then mutate the file.
      await new Promise(resolve => setTimeout(resolve, 10));
      await fs.writeFile(filepath, 'completely different content\n');
      const { result } = await drainGenerator(
        tryReadCacheHit(readCall({ file_path: filepath }), makeCtx()),
      );
      assert.equal(result, false, 'changed files must miss the cache');
    });

    it('returns NO hit after a compaction has run since the file was recorded', async () => {
      await maintainFileCache(readCall({ file_path: filepath }), cache);
      cache.noteCompaction(); // compaction sweeps the prior tool result away
      const { result } = await drainGenerator(
        tryReadCacheHit(readCall({ file_path: filepath }), makeCtx()),
      );
      assert.equal(
        result,
        false,
        'an entry recorded before compaction must not short-circuit — the model can no longer refer back to it',
      );
    });
  });
});
