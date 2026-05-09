import { describe, it } from 'node:test';
import assert from 'node:assert';
import { withBoundedTimeout } from '../../../src/utils/timeout.js';

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

describe('withBoundedTimeout', () => {
  it('returns the work value when work resolves before the budget', async () => {
    let timedOut = false;
    const got = await withBoundedTimeout(
      async () => {
        await sleep(10);
        return 'ok';
      },
      200,
      () => {
        timedOut = true;
      },
    );
    assert.strictEqual(got, 'ok');
    assert.strictEqual(timedOut, false);
  });

  it('resolves with undefined and fires onTimeout when work exceeds the budget', async () => {
    let timedOut = false;
    const got = await withBoundedTimeout(
      async () => {
        await sleep(200);
        return 'never';
      },
      30,
      () => {
        timedOut = true;
      },
    );
    assert.strictEqual(got, undefined);
    assert.strictEqual(timedOut, true);
  });

  it('propagates errors thrown synchronously by work', async () => {
    let timedOut = false;
    await assert.rejects(
      withBoundedTimeout(
        async () => {
          throw new Error('boom');
        },
        200,
        () => {
          timedOut = true;
        },
      ),
      /boom/,
    );
    // Timer should not fire when work rejected immediately.
    assert.strictEqual(timedOut, false);
  });

  it('propagates errors thrown asynchronously by work (before budget)', async () => {
    await assert.rejects(
      withBoundedTimeout(
        async () => {
          await sleep(10);
          throw new Error('async boom');
        },
        200,
        () => {},
      ),
      /async boom/,
    );
  });

  it('does not fire onTimeout twice even if work later resolves after the budget', async () => {
    let timeoutCount = 0;
    const got = await withBoundedTimeout(
      async () => {
        await sleep(80);
        return 'late';
      },
      20,
      () => {
        timeoutCount++;
      },
    );
    // The race resolves with undefined when timeout wins.
    assert.strictEqual(got, undefined);
    // Wait long enough for the slow work to also settle in the background.
    await sleep(120);
    // onTimeout should have fired exactly once — the race winner.
    assert.strictEqual(timeoutCount, 1);
  });
});
