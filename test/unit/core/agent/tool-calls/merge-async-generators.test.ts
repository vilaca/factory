import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mergeAsyncGenerators } from '../../../../../src/core/agent/tool-calls/merge-async-generators.js';

const tick = (): Promise<void> => new Promise(r => setImmediate(r));

describe('mergeAsyncGenerators', () => {
  it('returns an empty array for an empty input', async () => {
    const events: string[] = [];
    const returns: string[] = [];
    for await (const e of mergeAsyncGenerators<string, string>([])) events.push(e);
    // empty: the generator finishes immediately, return value is []
    const gen = mergeAsyncGenerators<string, string>([]);
    const r = await gen.next();
    assert.strictEqual(r.done, true);
    assert.deepStrictEqual(r.value, []);
    void returns;
  });

  it('interleaves events in completion order and collects returns by input index', async () => {
    async function* a(): AsyncGenerator<string, number> {
      yield 'a1';
      await tick();
      yield 'a2';
      return 1;
    }
    async function* b(): AsyncGenerator<string, number> {
      await tick();
      yield 'b1';
      yield 'b2';
      return 2;
    }

    const events: string[] = [];
    const gen = mergeAsyncGenerators<string, number>([a(), b()]);
    let returns: number[] = [];
    while (true) {
      const r = await gen.next();
      if (r.done) {
        returns = r.value;
        break;
      }
      events.push(r.value);
    }
    // All four events fire, in *some* interleaving (a1 before a2, b1 before b2).
    assert.strictEqual(events.length, 4);
    assert.ok(events.indexOf('a1') < events.indexOf('a2'));
    assert.ok(events.indexOf('b1') < events.indexOf('b2'));
    // Returns preserve input order, not completion order.
    assert.deepStrictEqual(returns, [1, 2]);
  });

  it('cancels source generators when the consumer breaks early', async () => {
    let aCleanedUp = false;
    let bCleanedUp = false;
    async function* a(): AsyncGenerator<string, void> {
      try {
        yield 'a1';
        yield 'a2';
      } finally {
        aCleanedUp = true;
      }
    }
    async function* b(): AsyncGenerator<string, void> {
      try {
        yield 'b1';
        yield 'b2';
      } finally {
        bCleanedUp = true;
      }
    }

    const gen = mergeAsyncGenerators<string, void>([a(), b()]);
    const first = await gen.next();
    assert.strictEqual(first.done, false);
    // Tell the merger we're done; it should propagate return() to children.
    await gen.return([] as void[] as never);

    assert.strictEqual(aCleanedUp, true);
    assert.strictEqual(bCleanedUp, true);
  });
});
