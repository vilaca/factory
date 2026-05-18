import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PermissionManager } from '../../../../../src/security/permissions.js';
import { runToolCalls } from '../../../../../src/core/agent/tool-calls/run-tool-calls.js';
import {
  callOf,
  collect,
  fakeTool,
  makeCtx,
  makeRecovery,
  makeRegistry,
} from './run-tool-calls-fixtures.js';

/** Yield to the microtask queue so a pending Promise.resolve() chain runs. */
const tick = (): Promise<void> => new Promise(r => setImmediate(r));

describe('runToolCalls — parallel Delegate batches', () => {
  it('runs two Delegate calls concurrently rather than sequentially', async () => {
    // Each delegate's execute waits on a release latch. If execution were
    // sequential, the first call would never release until we tick the
    // event loop after the second call's latch is set — but the second
    // call's latch isn't even reached until the first finishes. We prove
    // parallelism by setting both latches *before* either has resolved:
    // if the loop is parallel, both begin running and complete together.
    let releaseA: (() => void) | undefined;
    let releaseB: (() => void) | undefined;
    let startedA = false;
    let startedB = false;

    const delegate = fakeTool({
      name: 'Delegate',
      execute: async args => {
        const task = String(args.task ?? '');
        if (task === 'A') {
          startedA = true;
          await new Promise<void>(r => {
            releaseA = r;
          });
          return { success: true, output: 'A done' };
        }
        startedB = true;
        await new Promise<void>(r => {
          releaseB = r;
        });
        return { success: true, output: 'B done' };
      },
    });

    const permissions = new PermissionManager();
    permissions.allowAll('Delegate');
    const ctx = makeCtx({ permissions, toolRegistry: makeRegistry([delegate]) });

    const calls = [
      callOf('Delegate', { task: 'A' }, 'tc-a'),
      callOf('Delegate', { task: 'B' }, 'tc-b'),
    ];

    const promise = collect(runToolCalls(calls, ctx, 'sig', makeRecovery()));

    // Spin the event loop until both delegates have entered their execute.
    // Under sequential execution, only A would start; B would wait for A
    // to release first.
    for (let i = 0; i < 20 && !(startedA && startedB); i++) await tick();

    assert.strictEqual(startedA, true, 'A started');
    assert.strictEqual(startedB, true, 'B started in parallel with A');

    releaseA!();
    releaseB!();
    const { events } = await promise;

    // Both produced a tool-call-result.
    const results = events.filter(e => e.type === 'tool-call-result');
    assert.strictEqual(results.length, 2);
    assert.ok(delegate.calls.find(a => a.task === 'A'));
    assert.ok(delegate.calls.find(a => a.task === 'B'));
  });

  it('keeps a single Delegate call on the sequential path (no behavior change)', async () => {
    const delegate = fakeTool({ name: 'Delegate' });
    const permissions = new PermissionManager();
    permissions.allowAll('Delegate');
    const ctx = makeCtx({ permissions, toolRegistry: makeRegistry([delegate]) });
    const { events, result } = await collect(
      runToolCalls([callOf('Delegate', { task: 'solo' })], ctx, 'sig', makeRecovery()),
    );
    assert.strictEqual(delegate.calls.length, 1);
    assert.strictEqual(result.deniedCount, 0);
    assert.ok(events.some(e => e.type === 'tool-call-result'));
  });

  it('runs a mixed batch (Read then 2 Delegates then Read) with Delegates parallel and Reads sequential', async () => {
    const order: string[] = [];

    const readTool = fakeTool({
      name: 'Read',
      execute: async args => {
        order.push(`read:${args.label}`);
        return { success: true, output: `read-${args.label}` };
      },
    });

    let startedDelegates = 0;
    let releaseDelegates: (() => void) | undefined;
    const delegateBarrier = new Promise<void>(r => {
      releaseDelegates = r;
    });

    const delegate = fakeTool({
      name: 'Delegate',
      execute: async args => {
        startedDelegates++;
        order.push(`delegate-start:${args.task}`);
        await delegateBarrier;
        order.push(`delegate-end:${args.task}`);
        return { success: true, output: `delegate-${args.task}` };
      },
    });

    const permissions = new PermissionManager();
    permissions.allowAll('Read');
    permissions.allowAll('Delegate');
    const ctx = makeCtx({
      permissions,
      toolRegistry: makeRegistry([readTool, delegate]),
    });

    const calls = [
      callOf('Read', { label: 'first', file_path: '/x' }, 'r1'),
      callOf('Delegate', { task: 'D1' }, 'd1'),
      callOf('Delegate', { task: 'D2' }, 'd2'),
      callOf('Read', { label: 'last', file_path: '/y' }, 'r2'),
    ];

    const promise = collect(runToolCalls(calls, ctx, 'sig', makeRecovery()));

    for (let i = 0; i < 20 && startedDelegates < 2; i++) await tick();
    assert.strictEqual(
      startedDelegates,
      2,
      'both delegates started before the second Read ran',
    );

    // The first Read completed before delegates started; the second Read
    // should not have run yet because the delegate batch hasn't finished.
    assert.deepStrictEqual(order.filter(s => s.startsWith('read')), ['read:first']);

    releaseDelegates!();
    await promise;

    // After delegates finish, the second Read runs.
    assert.deepStrictEqual(order.filter(s => s.startsWith('read')), [
      'read:first',
      'read:last',
    ]);
    // Both delegates ran.
    assert.strictEqual(order.filter(s => s.startsWith('delegate-start')).length, 2);
    assert.strictEqual(order.filter(s => s.startsWith('delegate-end')).length, 2);
  });

  it('runs three parallel Delegates and counts denials independently', async () => {
    const delegate = fakeTool({ name: 'Delegate' });
    const permissions = new PermissionManager();
    // Don't allow-all; rely on per-call permission decisions. Each call
    // produces its own permission-request that the collector answers.
    const ctx = makeCtx({ permissions, toolRegistry: makeRegistry([delegate]) });

    const calls = [
      callOf('Delegate', { task: 'A' }, 'a'),
      callOf('Delegate', { task: 'B' }, 'b'),
      callOf('Delegate', { task: 'C' }, 'c'),
    ];
    let n = 0;
    const { result, events } = await collect(
      runToolCalls(calls, ctx, 'sig', makeRecovery()),
      {
        // Deny the second call, allow the others.
        onPermission: () => {
          n++;
          return n === 2 ? 'deny' : 'allow';
        },
      },
    );

    assert.strictEqual(result.deniedCount, 1, 'exactly one denial counted');
    // Two delegates actually executed (A and C); B was denied at the gate.
    assert.strictEqual(delegate.calls.length, 2);
    // Three permission-request events were yielded (one per call).
    assert.strictEqual(
      events.filter(e => e.type === 'permission-request').length,
      3,
    );
  });

  it('serializes permission prompts within a parallel Delegate batch', async () => {
    // Even though the two Delegate executions run in parallel, the host
    // should only ever see one outstanding permission-request at a time —
    // the AsyncMutex inside runDelegateBatch gates the prompt yield.
    let aStarted = false;
    let bStarted = false;
    const delegate = fakeTool({
      name: 'Delegate',
      execute: async args => {
        if (args.task === 'A') aStarted = true;
        if (args.task === 'B') bStarted = true;
        return { success: true, output: `done-${args.task}` };
      },
    });

    const permissions = new PermissionManager();
    const ctx = makeCtx({ permissions, toolRegistry: makeRegistry([delegate]) });

    const gen = runToolCalls(
      [callOf('Delegate', { task: 'A' }, 'a'), callOf('Delegate', { task: 'B' }, 'b')],
      ctx,
      'sig',
      makeRecovery(),
    );

    // Pull events one at a time. We deliberately do NOT respond to the
    // first permission-request until we have probed the stream for a
    // second one. If serialization is broken, the second prompt would
    // appear before we answer the first.
    let firstPrompt: ((d: 'allow' | 'deny') => void) | undefined;
    let sawSecondPromptWhileFirstHeld = false;
    let resolvedFirst = false;

    // Pump events asynchronously so we can observe them while keeping
    // the first prompt suspended.
    const pump = (async () => {
      while (true) {
        const r = await gen.next();
        if (r.done) return;
        if (r.value.type === 'permission-request') {
          if (!firstPrompt) {
            firstPrompt = r.value.respond;
          } else if (!resolvedFirst) {
            sawSecondPromptWhileFirstHeld = true;
            // Drain by allowing both, but the assertion has already
            // captured the violation.
            r.value.respond('allow');
          } else {
            r.value.respond('allow');
          }
        }
      }
    })();

    // Spin a few ticks so the first prompt definitely materializes and
    // the second pipeline's prompt would too, if not gated.
    for (let i = 0; i < 30; i++) await tick();

    assert.ok(firstPrompt, 'first prompt arrived');
    assert.strictEqual(
      sawSecondPromptWhileFirstHeld,
      false,
      'second prompt did NOT arrive while first was unanswered',
    );

    // Now answer the first; the second should follow.
    resolvedFirst = true;
    firstPrompt!('allow');
    await pump;

    // Both delegates eventually executed.
    assert.strictEqual(aStarted, true);
    assert.strictEqual(bStarted, true);
    assert.strictEqual(delegate.calls.length, 2);
  });

  it('does not re-prompt within a batch when the first answer is allow-all', async () => {
    // Answering the first prompt with `allow-all` flips the permission
    // manager's auto-allow flag for that tool. The next pipeline in the
    // same batch, blocked on the mutex, must re-check the flag *after*
    // acquiring the lock and skip its prompt entirely.
    const delegate = fakeTool({ name: 'Delegate' });
    const permissions = new PermissionManager();
    const ctx = makeCtx({ permissions, toolRegistry: makeRegistry([delegate]) });

    let promptCount = 0;
    const { events } = await collect(
      runToolCalls(
        [
          callOf('Delegate', { task: 'A' }, 'a'),
          callOf('Delegate', { task: 'B' }, 'b'),
          callOf('Delegate', { task: 'C' }, 'c'),
        ],
        ctx,
        'sig',
        makeRecovery(),
      ),
      {
        onPermission: () => {
          promptCount++;
          return 'allow-all';
        },
      },
    );

    assert.strictEqual(promptCount, 1, 'only the first delegate prompted');
    assert.strictEqual(delegate.calls.length, 3, 'all three still executed');
    assert.strictEqual(
      events.filter(e => e.type === 'permission-request').length,
      1,
    );
  });

  it('does not hang queued prompts when abort fires mid-batch', async () => {
    // Regression: while pipeline A held the permission mutex and awaited its
    // prompt, B was parked inside acquire(). When the signal aborted, A
    // unwound and released; B then woke up and entered requestPermission
    // *after* the signal had already fired. addEventListener('abort') does
    // not auto-fire for an already-dispatched event, so B's permission
    // promise would hang forever. requestPermission now short-circuits on
    // entry when signal.aborted is already true.
    const delegate = fakeTool({ name: 'Delegate' });
    const permissions = new PermissionManager();
    const controller = new AbortController();
    const ctx = makeCtx({
      permissions,
      toolRegistry: makeRegistry([delegate]),
      signal: controller.signal,
    });

    const gen = runToolCalls(
      [callOf('Delegate', { task: 'A' }, 'a'), callOf('Delegate', { task: 'B' }, 'b')],
      ctx,
      'sig',
      makeRecovery(),
    );

    const events: AgentEvent[] = [];
    const firstPromptArrived = new Promise<void>(resolveFirst => {
      void (async () => {
        while (true) {
          const r = await gen.next().catch(err => ({ done: true, value: err }) as const);
          if ('done' in r && r.done) return;
          const ev = r.value as AgentEvent;
          events.push(ev);
          if (ev.type === 'permission-request') {
            resolveFirst();
            // Deliberately do NOT respond — the abort below should unblock A.
            // B's prompt, if it ever materialises, would hang the test.
            return;
          }
        }
      })();
    });

    await firstPromptArrived;
    controller.abort();

    // Drain to completion. If the bug is present, this await never resolves
    // (the test runner's timeout would surface the hang as a failure).
    while (true) {
      const r = await gen.next();
      if (r.done) break;
      events.push(r.value);
      if (r.value.type === 'permission-request') {
        r.value.respond('allow');
      }
    }

    // B should never have produced its own permission-request after abort.
    const prompts = events.filter(e => e.type === 'permission-request');
    assert.strictEqual(prompts.length, 1, 'only A prompted; B short-circuited on abort');
  });

  it('propagates an aborted signal before starting the batch', async () => {
    const delegate = fakeTool({ name: 'Delegate' });
    const permissions = new PermissionManager();
    permissions.allowAll('Delegate');
    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx({
      permissions,
      toolRegistry: makeRegistry([delegate]),
      signal: controller.signal,
    });

    await assert.rejects(
      () =>
        collect(
          runToolCalls(
            [callOf('Delegate', { task: 'A' }), callOf('Delegate', { task: 'B' })],
            ctx,
            'sig',
            makeRecovery(),
          ),
        ),
      (err: Error) => err.name === 'AbortError',
    );
    assert.strictEqual(delegate.calls.length, 0);
  });
});
