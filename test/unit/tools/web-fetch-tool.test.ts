import { describe, it } from 'node:test';
import assert from 'node:assert';
import { webFetchTool } from '../../../src/tools/web-fetch.js';
import { PermissionManager } from '../../../src/permissions.js';
import { parsePermissionInput } from '../../../src/ui/ink/components/permission-panel.js';

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
