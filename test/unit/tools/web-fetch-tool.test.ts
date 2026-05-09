import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { webFetchTool } from '../../../src/tools/web/index.js';
import { fetchUrl } from '../../../src/tools/web/fetch.js';
import { PermissionManager } from '../../../src/security/permissions.js';
import { parsePermissionInput } from '../../../src/ui/tui/components/permission-panel.js';

describe('WebFetch tool', () => {
  it('rejects missing url', async () => {
    const r = await webFetchTool.execute({});
    assert.strictEqual(r.success, false);
    assert.match(r.output, /url.*required/i);
  });

  it('rejects malformed url', async () => {
    const r = await webFetchTool.execute({ url: 'not a url' });
    assert.strictEqual(r.success, false);
    assert.match(r.output, /invalid URL/i);
  });

  it('rejects non-http(s) protocols', async () => {
    const r = await webFetchTool.execute({ url: 'file:///etc/passwd' });
    assert.strictEqual(r.success, false);
    assert.match(r.output, /unsupported protocol/i);
  });

  it('blocks redirects to a host outside the allowlist', async () => {
    // Server chains: docs.example.com → http://127.0.0.1/. The tool only
    // approved docs.example.com, so the second hop must be refused.
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('https://docs.example.com')) {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;
    await assert.rejects(
      fetchUrl('https://docs.example.com/x', {
        fetchImpl,
        validateHop: (u: URL) =>
          u.hostname.toLowerCase() === 'docs.example.com'
            ? null
            : `redirect to "${u.hostname}" blocked`,
      }),
      /redirect to "127\.0\.0\.1" blocked/,
    );
  });

  it('rejects the initial URL when validateHop refuses it (no fetch happens)', async () => {
    // The redirect cases prove validateHop runs on hop targets; this proves
    // the initial URL goes through the same gate, so no request fires.
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response('should not happen');
    }) as typeof fetch;
    await assert.rejects(
      fetchUrl('https://blocked.example.com/x', {
        fetchImpl,
        validateHop: () => 'host blocked',
      }),
      /host blocked/,
    );
    assert.strictEqual(fetchCalls, 0);
  });

  it('rejects the response when Content-Length advertises more than the cap allows', async () => {
    // The pre-flight bails before any body bytes are read so a server that
    // honestly reports a huge response can't force us to allocate.
    const fetchImpl = (async () =>
      new Response('x', {
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-length': '999999999' },
      })) as typeof fetch;
    await assert.rejects(
      fetchUrl('https://example.com/big', { fetchImpl, maxBytes: 1024 }),
      /response advertises 999999999 bytes/,
    );
  });

  it('refuses a Response that exposes no streaming body', async () => {
    // `new Response(null)` is the closest spec-compliant way to produce a
    // body=null Response. We refuse rather than fall back to res.text(),
    // which would buffer uncapped.
    const fetchImpl = (async () =>
      new Response(null, { status: 200, headers: { 'content-type': 'text/plain' } })) as typeof fetch;
    await assert.rejects(
      fetchUrl('https://example.com/empty', { fetchImpl }),
      /no streaming body/,
    );
  });

  it('truncates the body at maxBytes and reports truncated=true', async () => {
    const big = 'x'.repeat(500);
    const fetchImpl = (async () =>
      new Response(big, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })) as typeof fetch;
    const res = await fetchUrl('https://example.com/big', { fetchImpl, maxBytes: 100 });
    assert.strictEqual(res.truncated, true);
    assert.strictEqual(res.body.length, 100);
  });

  it('honours an explicit charset directive in Content-Type', async () => {
    // Latin-1 0xE9 is "é" — UTF-8 would mojibake it. Proves we honour the
    // server's declared encoding rather than always assuming UTF-8.
    const fetchImpl = (async () =>
      new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=iso-8859-1' },
      })) as typeof fetch;
    const res = await fetchUrl('https://example.com/x', { fetchImpl });
    assert.strictEqual(res.body, 'café');
  });

  it('falls back to UTF-8 when the declared charset is unknown', async () => {
    // TextDecoder throws on construction with an unknown label; the catch
    // route must still produce a usable string rather than propagate.
    const fetchImpl = (async () =>
      new Response('hello', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=not-a-real-encoding' },
      })) as typeof fetch;
    const res = await fetchUrl('https://example.com/x', { fetchImpl });
    assert.strictEqual(res.body, 'hello');
  });

  it('throws on a redirect response with no Location header', async () => {
    const fetchImpl = (async () => new Response(null, { status: 302 })) as typeof fetch;
    await assert.rejects(
      fetchUrl('https://example.com/x', { fetchImpl }),
      /redirect 302 without Location header/,
    );
  });

  it('throws when the redirect chain exceeds maxRedirects', async () => {
    // Each hop redirects to itself — the cap must fire instead of looping.
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/loop' },
      })) as typeof fetch;
    await assert.rejects(
      fetchUrl('https://example.com/loop', { fetchImpl, maxRedirects: 2 }),
      /too many redirects \(>2\)/,
    );
  });

  it('throws on a non-OK terminal response', async () => {
    const fetchImpl = (async () =>
      new Response('boom', { status: 503, statusText: 'Service Unavailable' })) as typeof fetch;
    await assert.rejects(
      fetchUrl('https://example.com/down', { fetchImpl }),
      /HTTP 503 Service Unavailable/,
    );
  });

  it('permits redirects to a host explicitly in the allowlist', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://docs.example.com/x') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://www.example.com/y' },
        });
      }
      if (url === 'https://www.example.com/y') {
        return new Response('hello', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;
    const allowed = new Set(['docs.example.com', 'www.example.com']);
    const result = await fetchUrl('https://docs.example.com/x', {
      fetchImpl,
      validateHop: (u: URL) => (allowed.has(u.hostname.toLowerCase()) ? null : 'blocked'),
    });
    assert.strictEqual(result.url, 'https://www.example.com/y');
    assert.strictEqual(result.body, 'hello');
  });
});

describe('WebFetch tool — execute() success paths', () => {
  // The early-return error branches above run without I/O. The interesting
  // post-fetch branches (HTML→md vs plain vs raw, output truncation tail,
  // redirect-URL prefix, validateHop protocol block) need a real call into
  // fetchUrl, which uses globalThis.fetch. Stub it for this block only.
  let originalFetch: typeof globalThis.fetch;
  before(() => {
    originalFetch = globalThis.fetch;
  });
  after(() => {
    globalThis.fetch = originalFetch;
  });

  const stubFetch = (impl: (url: string) => Response): void => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      impl(typeof input === 'string' ? input : input.toString())) as typeof fetch;
  };

  it('converts HTML responses to markdown and labels the mode', async () => {
    stubFetch(
      () =>
        new Response('<p>hello <strong>world</strong></p>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    );
    const r = await webFetchTool.execute({ url: 'https://example.com/x' });
    assert.strictEqual(r.success, true);
    assert.match(r.output, /html→markdown/);
    assert.match(r.output, /hello \*\*world\*\*/);
  });

  it('returns plain text bodies as-is and labels the mode', async () => {
    stubFetch(
      () =>
        new Response('first line\nsecond line', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    const r = await webFetchTool.execute({ url: 'https://example.com/x' });
    assert.strictEqual(r.success, true);
    assert.match(r.output, /plain text/);
    assert.match(r.output, /first line\nsecond line/);
  });

  it('falls back to a raw view for unsupported content-types and includes the type in the preamble', async () => {
    stubFetch(
      () =>
        new Response('{"k":1}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const r = await webFetchTool.execute({ url: 'https://example.com/x' });
    assert.strictEqual(r.success, true);
    assert.match(r.output, /— raw\n/);
    assert.match(r.output, /\[unsupported content-type: application\/json/);
    assert.match(r.output, /\{"k":1\}/);
  });

  it('truncates output past the model cap with a footer reporting how much was dropped', async () => {
    // 20 KiB plain text exceeds the 16 KiB MODEL_OUTPUT_CAP — the trailing
    // `... [truncated N chars to fit the WebFetch output cap]` line should
    // appear and the visible output should not contain the trailing marker
    // we appended past the cap.
    const big = 'x'.repeat(20 * 1024) + 'TAIL_MARKER';
    stubFetch(
      () =>
        new Response(big, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    const r = await webFetchTool.execute({ url: 'https://example.com/x' });
    assert.strictEqual(r.success, true);
    assert.match(r.output, /\[truncated \d+ chars to fit the WebFetch output cap\]/);
    assert.ok(!r.output.includes('TAIL_MARKER'));
  });

  it('annotates the output with the post-redirect URL when the chain rewrote it', async () => {
    let calls = 0;
    stubFetch(url => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://example.com/new' },
        });
      }
      assert.strictEqual(url, 'https://example.com/new');
      return new Response('arrived', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    });
    const r = await webFetchTool.execute({ url: 'https://example.com/old' });
    assert.strictEqual(r.success, true);
    assert.match(r.output, /\(final URL after redirects: https:\/\/example\.com\/new\)/);
  });

  it('refuses a redirect to a non-http(s) protocol via the validateHop protocol gate', async () => {
    // Same host, but the redirect target's scheme is ftp — the protocol
    // check fires before the hostname allowlist branch. Without the gate,
    // node-fetch would happily fetch ftp:// or worse, javascript:.
    stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'ftp://example.com/data' },
        }),
    );
    const r = await webFetchTool.execute({ url: 'https://example.com/x' });
    assert.strictEqual(r.success, false);
    assert.match(r.output, /redirect to unsupported protocol "ftp:"/);
  });

  it('threads ToolContext.isHostnameAllowed through to validateHop so allowlisted hosts pass', async () => {
    // Cross-host redirect that would normally be refused; ctx pre-allows it.
    stubFetch(url => {
      if (url === 'https://docs.example.com/x') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://www.example.com/y' },
        });
      }
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    });
    const r = await webFetchTool.execute(
      { url: 'https://docs.example.com/x' },
      { cwd: '/', isHostnameAllowed: (h: string) => h === 'www.example.com' },
    );
    assert.strictEqual(r.success, true);
    assert.match(r.output, /\(final URL after redirects: https:\/\/www\.example\.com\/y\)/);
  });
});

describe('PermissionManager domain allowlist', () => {
  it('allowDomain + isDomainAllowed round-trip, case-insensitive', () => {
    const p = new PermissionManager();
    assert.strictEqual(p.isDomainAllowed('docs.example.com'), false);
    p.allowDomain('docs.example.com');
    assert.strictEqual(p.isDomainAllowed('docs.example.com'), true);
    // Case-insensitive: hostnames are conventionally lowercased.
    assert.strictEqual(p.isDomainAllowed('DOCS.EXAMPLE.COM'), true);
    p.allowDomain('Other.Example.COM');
    assert.strictEqual(p.isDomainAllowed('other.example.com'), true);
  });

  it('reset() clears both tools and domains', () => {
    const p = new PermissionManager();
    p.allowAll('Bash');
    p.allowDomain('docs.example.com');
    p.reset();
    assert.strictEqual(p.isAutoAllowed('Bash'), false);
    assert.strictEqual(p.isDomainAllowed('docs.example.com'), false);
  });

  it('listAllowedDomains returns sorted snapshot', () => {
    const p = new PermissionManager();
    p.allowDomain('z.example.com');
    p.allowDomain('a.example.com');
    p.allowDomain('m.example.com');
    assert.deepStrictEqual(p.listAllowedDomains(), [
      'a.example.com',
      'm.example.com',
      'z.example.com',
    ]);
  });

  it('domain allowlist is independent of tool allowlist', () => {
    const p = new PermissionManager();
    p.allowDomain('docs.example.com');
    // Whitelisting a domain must NOT auto-allow WebFetch globally.
    assert.strictEqual(p.isAutoAllowed('WebFetch'), false);
  });
});

describe('parsePermissionInput', () => {
  it('y/yes/empty → allow', () => {
    assert.strictEqual(parsePermissionInput('y'), 'allow');
    assert.strictEqual(parsePermissionInput('yes'), 'allow');
    assert.strictEqual(parsePermissionInput(''), 'allow');
  });

  it('a/allow/allow all → allow-all', () => {
    assert.strictEqual(parsePermissionInput('a'), 'allow-all');
    assert.strictEqual(parsePermissionInput('allow'), 'allow-all');
    assert.strictEqual(parsePermissionInput('allow all'), 'allow-all');
  });

  it('w/whitelist on WebFetch → allow-domain', () => {
    assert.strictEqual(parsePermissionInput('w', 'WebFetch'), 'allow-domain');
    assert.strictEqual(parsePermissionInput('whitelist', 'WebFetch'), 'allow-domain');
  });

  it('w on a non-WebFetch tool falls through to deny (no allow-domain leakage)', () => {
    assert.strictEqual(parsePermissionInput('w', 'Bash'), 'deny');
    assert.strictEqual(parsePermissionInput('w'), 'deny');
  });

  it('unknown input → deny', () => {
    assert.strictEqual(parsePermissionInput('huh'), 'deny');
    assert.strictEqual(parsePermissionInput('n'), 'deny');
  });
});
