import { describe, it } from 'node:test';
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
