import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert';
import { McpManager } from '../../src/mcp/client.js';

describe('McpManager — input validation', () => {
  afterEach(() => mock.reset());

  it('rejects non-stdio transports', async () => {
    const m = new McpManager();
    await assert.rejects(
      m.connectServer({ name: 'x', transport: 'sse', url: 'http://localhost' }),
      /not yet supported/,
    );
  });

  it('rejects stdio without a command', async () => {
    const m = new McpManager();
    await assert.rejects(
      m.connectServer({ name: 'x', transport: 'stdio' }),
      /requires a "command"/,
    );
  });

  it('connectAll keeps going past one failing server, surfacing the error to stderr', async () => {
    const errSpy = mock.method(console, 'error', () => {});
    const m = new McpManager();
    const tools = await m.connectAll([
      { name: 'bad-transport', transport: 'sse', url: 'x' },
      { name: 'bad-stdio', transport: 'stdio' },
    ]);
    assert.deepStrictEqual(tools, []);
    // Both failures get reported, neither aborts the loop.
    assert.strictEqual(errSpy.mock.calls.length, 2);
    assert.match(errSpy.mock.calls[0]!.arguments[0] as string, /bad-transport/);
    assert.match(errSpy.mock.calls[1]!.arguments[0] as string, /bad-stdio/);
  });

  it('getAllTools returns [] when no servers are connected', () => {
    assert.deepStrictEqual(new McpManager().getAllTools(), []);
  });

  it('disconnect on an empty manager is a no-op (resolves cleanly)', async () => {
    const result = await new McpManager().disconnect();
    assert.deepStrictEqual(result, { pending: [] });
  });

  it('disconnect bounds each server to perServerTimeoutMs and reports stuck servers', async () => {
    const m = new McpManager();
    // Inject two fake connections — one that closes immediately, one that
    // hangs forever — to exercise the per-server cap without spawning a
    // real MCP subprocess.
    const okClose = mock.fn(async () => {});
    const hangClose = mock.fn(() => new Promise<void>(() => {}));
    (m as unknown as { connections: unknown[] }).connections = [
      { client: { close: okClose }, transport: {}, serverName: 'fast', tools: [] },
      { client: { close: hangClose }, transport: {}, serverName: 'hangy', tools: [] },
    ];
    const t0 = Date.now();
    const result = await m.disconnect(80);
    const elapsed = Date.now() - t0;
    // Took ~80ms for the hung server (must exceed timeout, must not run
    // the full default 2s, and must finish promptly after the cap).
    assert.ok(elapsed >= 80 && elapsed < 1000, `disconnect took ${elapsed}ms`);
    assert.deepStrictEqual(result.pending, ['hangy']);
    assert.strictEqual(okClose.mock.callCount(), 1);
    assert.strictEqual(hangClose.mock.callCount(), 1);
    // Manager must clear its connections regardless of which servers timed
    // out — otherwise a second disconnect would re-attempt them.
    assert.deepStrictEqual(m.getAllTools(), []);
  });
});
