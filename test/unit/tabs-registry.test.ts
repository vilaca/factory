import { describe, it } from 'node:test';
import assert from 'node:assert';
import { TabsRegistry } from '../../src/ui/ink/tabs/tabs-registry.js';
import type { AgentLoopApi } from '../../src/ui/ink/agent-loop/types.js';

// Build a minimal AgentLoopApi stub. Most tests only care about identity,
// so we cast through unknown — the tabs registry never invokes most of these
// methods.
function stubApi(model = 'stub'): AgentLoopApi {
  return { model } as unknown as AgentLoopApi;
}

describe('TabsRegistry', () => {
  it('register/get round-trips through the getter', () => {
    const r = new TabsRegistry();
    const api = stubApi('m1');
    r.register(1, () => api);
    assert.strictEqual(r.get(1), api);
    assert.strictEqual(r.has(1), true);
    assert.strictEqual(r.size(), 1);
    assert.deepStrictEqual(r.ids(), [1]);
  });

  it('get() reads the latest value via the getter (survives api re-renders)', () => {
    // The Session passes a closure over a ref so React re-renders update the
    // returned api without re-registering. This is the property that lets the
    // registry stay correct without churn.
    const r = new TabsRegistry();
    let live: AgentLoopApi = stubApi('first');
    r.register(1, () => live);
    assert.strictEqual(r.get(1)?.model, 'first');
    live = stubApi('second');
    assert.strictEqual(r.get(1)?.model, 'second');
  });

  it('unregister removes the entry and notifies subscribers', () => {
    const r = new TabsRegistry();
    let count = 0;
    r.subscribe(() => { count++; });
    r.register(1, () => stubApi());
    r.register(2, () => stubApi());
    assert.strictEqual(r.size(), 2);
    const beforeUnreg = count;
    r.unregister(1);
    assert.strictEqual(r.has(1), false);
    assert.strictEqual(r.size(), 1);
    assert.ok(count > beforeUnreg, 'unregister should notify');
  });

  it('unregister of an unknown id is a no-op (no notify)', () => {
    const r = new TabsRegistry();
    let count = 0;
    r.subscribe(() => { count++; });
    r.unregister(999);
    assert.strictEqual(count, 0);
  });

  it('subscribe returns an unsubscribe function', () => {
    const r = new TabsRegistry();
    let count = 0;
    const unsub = r.subscribe(() => { count++; });
    r.register(1, () => stubApi());
    const after = count;
    unsub();
    r.register(2, () => stubApi());
    assert.strictEqual(count, after, 'unsubscribed listener must not fire');
  });

  it('setStatus is a no-op when the badge is unchanged (avoids notify storms)', () => {
    // The TabStrip subscribes via useSyncExternalStore. If setStatus fired
    // notifications on every render even when the badge is unchanged, every
    // tab would re-render on every keystroke. The dedup is load-bearing.
    const r = new TabsRegistry();
    r.register(1, () => stubApi());
    let count = 0;
    r.subscribe(() => { count++; });
    r.setStatus(1, { badge: 'running' });
    const afterFirst = count;
    r.setStatus(1, { badge: 'running' });
    assert.strictEqual(count, afterFirst, 'duplicate badge should not notify');
    r.setStatus(1, { badge: null });
    assert.ok(count > afterFirst, 'badge change should notify');
  });

  it('setStatus on an unregistered id is ignored', () => {
    const r = new TabsRegistry();
    r.setStatus(99, { badge: 'running' });
    assert.deepStrictEqual(r.getStatus(99), { badge: null });
  });

  it('getStatus returns a default object when id is unknown', () => {
    const r = new TabsRegistry();
    const status = r.getStatus(42);
    assert.deepStrictEqual(status, { badge: null });
  });

  it('unregister also clears status', () => {
    const r = new TabsRegistry();
    r.register(1, () => stubApi());
    r.setStatus(1, { badge: 'awaiting-permission' });
    r.unregister(1);
    assert.deepStrictEqual(r.getStatus(1), { badge: null });
  });
});
