import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AsyncMutex } from '../../../../../src/core/agent/tool-calls/async-mutex.js';

const tick = (): Promise<void> => new Promise(r => setImmediate(r));

describe('AsyncMutex', () => {
  it('serializes critical sections in FIFO order', async () => {
    const m = new AsyncMutex();
    const order: string[] = [];

    async function section(label: string, work: () => Promise<void>): Promise<void> {
      const release = await m.acquire();
      order.push(`${label}:enter`);
      try {
        await work();
      } finally {
        order.push(`${label}:exit`);
        release();
      }
    }

    // Kick off three sections that each await a microtask. If the mutex
    // works, they enter and exit in registration order with no overlap.
    const promises = [
      section('A', async () => {
        await tick();
        await tick();
      }),
      section('B', async () => {
        await tick();
      }),
      section('C', async () => {
        // empty
      }),
    ];
    await Promise.all(promises);

    assert.deepStrictEqual(order, [
      'A:enter',
      'A:exit',
      'B:enter',
      'B:exit',
      'C:enter',
      'C:exit',
    ]);
  });

  it('immediately admits the first acquirer without yielding', async () => {
    const m = new AsyncMutex();
    let admitted = false;
    void m.acquire().then(() => {
      admitted = true;
    });
    // After one microtask flush the first acquire should be resolved.
    await tick();
    assert.strictEqual(admitted, true);
  });

  it('release with no waiters frees the slot for a subsequent acquire', async () => {
    const m = new AsyncMutex();
    const r1 = await m.acquire();
    r1();
    // No waiter was queued; the next acquire should resolve without
    // anyone calling release on its behalf.
    const r2 = await m.acquire();
    r2();
    assert.ok(true);
  });

  it('does not let a fresh acquirer steal the slot from a queued waiter', async () => {
    const m = new AsyncMutex();
    const order: string[] = [];
    const r1 = await m.acquire();

    // Queue a waiter. It must run before any newcomer.
    const waiter = m.acquire().then(release => {
      order.push('waiter');
      release();
    });

    // Newcomer arrives *after* the waiter is queued but *before* r1 releases.
    const newcomer = m.acquire().then(release => {
      order.push('newcomer');
      release();
    });

    await tick();
    r1();
    await Promise.all([waiter, newcomer]);
    assert.deepStrictEqual(order, ['waiter', 'newcomer']);
  });
});
