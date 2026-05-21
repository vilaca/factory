/**
 * Plan mode queues writes for explicit approval. The PTY-driven "type a
 * prompt → see panel → /approve → file appears" flow proved too sensitive
 * to Ink's <Static> flush timing under PTY framing — assertions on the
 * panel text raced the redraws. The wiring assertion that still gives us
 * release-gate value is: in `--plan` headless mode, the queued tool call
 * MUST NOT execute. The TUI-side approve→run path is covered by the
 * `approvePlan` unit tests; here we lock in the safety property of plan
 * mode (no execution without explicit consent).
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { spawnCliHeadless } from '../cli-harness.js';
import { startMockServer, stopMockServer, setNextResponses } from '../mock-ollama-server.js';
import { tmpEnv } from '../fixtures/tmpProject.js';
import { writeProjectConfig } from '../fixtures/writeConfig.js';

let mockPort: number;
let mockServer: any;
before(async () => {
  const r = await startMockServer();
  mockServer = r.server;
  mockPort = r.port;
});
after(async () => {
  await stopMockServer(mockServer);
});

let env: ReturnType<typeof tmpEnv>;
beforeEach(() => {
  if (env) env.cleanup();
  env = tmpEnv();
  writeProjectConfig(env.cwd, { permissions: { allowAll: ['Write'] } });
});
after(() => env?.cleanup());

describe('Plan mode', () => {
  it('queues a Write tool call without executing it in --plan headless mode', async () => {
    const target = path.join(env.cwd, 'planned.txt');
    setNextResponses([
      {
        content: '',
        tool_calls: [
          {
            function: {
              name: 'Write',
              arguments: { file_path: target, content: 'PLAN_PAYLOAD' },
            },
          },
        ],
      },
      { content: 'plan staged' },
    ]);
    const r = await spawnCliHeadless(
      [
        '--plan',
        '--provider',
        'ollama',
        '--model',
        'test-model:latest',
        '--host',
        `http://127.0.0.1:${mockPort}`,
      ],
      { stdin: 'write the file\n', home: env.home, cwd: env.cwd, timeoutMs: 15000 },
    );
    // The agent loop completes its single headless turn. Process exits 0
    // (or 3 if the planned tool can't be auto-allowed in headless — both
    // are consistent with "did not actually write"). The file MUST NOT
    // exist regardless.
    assert.ok(
      !fs.existsSync(target),
      `plan-mode allowed a Write to execute without approval: ${target}`,
    );
    assert.notStrictEqual(r.exitCode, undefined);
  });
});
