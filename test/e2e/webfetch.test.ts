/**
 * WebFetch end-to-end against a local mock HTTP server. The agent loop has
 * to: pre-seed the allowlist from `agent.web.allowlist` so headless doesn't
 * stall on a permission prompt, then issue the request, then render the
 * HTML to Markdown.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { spawnCliHeadless } from '../cli-harness.js';
import { startMockServer, stopMockServer, setNextResponses } from '../mock-ollama-server.js';
import { startMockWebServer, stopMockWebServer } from '../mocks/mock-web-server.js';
import { tmpEnv } from '../fixtures/tmpProject.js';
import { writeGlobalConfig } from '../fixtures/writeConfig.js';

let mockPort: number;
let mockServer: any;
let webPort: number;
let webServer: any;
before(async () => {
  const ol = await startMockServer();
  mockServer = ol.server;
  mockPort = ol.port;
  const w = await startMockWebServer();
  webServer = w.server;
  webPort = w.port;
});
after(async () => {
  await stopMockServer(mockServer);
  await stopMockWebServer(webServer);
});

let env: ReturnType<typeof tmpEnv>;
beforeEach(() => {
  if (env) env.cleanup();
  env = tmpEnv();
});
after(() => env?.cleanup());

describe('WebFetch (headless)', () => {
  it('fetches a known URL when the host is on the allowlist', async () => {
    writeGlobalConfig(env.home, {
      provider: 'ollama',
      model: 'test-model:latest',
      host: `http://127.0.0.1:${mockPort}`,
      agent: { web: { allowlist: ['127.0.0.1'] } },
      permissions: { allowAll: ['WebFetch'] },
    });
    setNextResponses([
      {
        content: '',
        tool_calls: [
          {
            function: {
              name: 'WebFetch',
              arguments: { url: `http://127.0.0.1:${webPort}/hello` },
            },
          },
        ],
      },
      { content: 'fetched' },
    ]);
    const r = await spawnCliHeadless(
      [
        '--provider',
        'ollama',
        '--model',
        'test-model:latest',
        '--host',
        `http://127.0.0.1:${mockPort}`,
      ],
      { stdin: 'fetch it\n', home: env.home, cwd: env.cwd, timeoutMs: 15000 },
    );
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.match(r.stderr, /✓ WebFetch/);
    // Banner / model reply path: stdout should at least see the 2nd-turn
    // text content.
    assert.ok(r.stdout.includes('fetched'), `stdout: ${r.stdout}`);
  });

  it('surfaces a 404 as a tool failure (not a process crash)', async () => {
    writeGlobalConfig(env.home, {
      provider: 'ollama',
      model: 'test-model:latest',
      host: `http://127.0.0.1:${mockPort}`,
      agent: { web: { allowlist: ['127.0.0.1'] } },
      permissions: { allowAll: ['WebFetch'] },
    });
    setNextResponses([
      {
        content: '',
        tool_calls: [
          {
            function: {
              name: 'WebFetch',
              arguments: { url: `http://127.0.0.1:${webPort}/missing` },
            },
          },
        ],
      },
      { content: 'recovered' },
    ]);
    const r = await spawnCliHeadless(
      [
        '--provider',
        'ollama',
        '--model',
        'test-model:latest',
        '--host',
        `http://127.0.0.1:${mockPort}`,
      ],
      { stdin: 'fetch a 404\n', home: env.home, cwd: env.cwd, timeoutMs: 15000 },
    );
    // Exit 0 — the run completes even when the fetch failed; the model
    // continues after seeing the failure.
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.match(r.stderr, /WebFetch/);
  });
});
