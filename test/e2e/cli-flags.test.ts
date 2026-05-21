/**
 * Surface-level CLI flag tests — neither --version nor --help should ever
 * touch the network, load a provider, or read any config. Regressions here
 * (e.g. a startup phase that runs unconditionally before the --version
 * branch) would surface as a slow / failing test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnCliHeadless } from '../cli-harness.js';

describe('CLI flags', () => {
  it('--version prints a semver and exits 0', async () => {
    const r = await spawnCliHeadless(['--version']);
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /factory \d+\.\d+\.\d+/);
  });

  it('-V is an alias for --version', async () => {
    const r = await spawnCliHeadless(['-V']);
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /factory \d+\.\d+\.\d+/);
  });

  it('--help prints usage including key flags and exits 0', async () => {
    const r = await spawnCliHeadless(['--help']);
    assert.strictEqual(r.exitCode, 0, r.stderr);
    for (const expected of [
      'Usage:',
      'factory [options] [model]',
      '--model, -m <name>',
      '--provider, -p <name>',
      '--plan',
      '--no-log',
      '--strict-log',
      '--turn-timeout',
      '--rotate',
      '--compaction-model',
    ]) {
      assert.ok(r.stdout.includes(expected), `--help missing: ${expected}`);
    }
  });

  it('-h is an alias for --help', async () => {
    const r = await spawnCliHeadless(['-h']);
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes('Usage:'));
  });

  it('--version returns before any provider connection is attempted', async () => {
    // No --host / --provider / mock server. If startup ran before the early
    // exit branch this would try to connect to a real Ollama and fail (or
    // hang on the picker). Assertion is "exited fast, cleanly, with version".
    const r = await spawnCliHeadless(['--version']);
    assert.strictEqual(r.exitCode, 0);
    assert.ok(r.durationMs < 5000, `--version took ${r.durationMs}ms`);
  });

  it('--turn-timeout with a non-positive number fails fast', async () => {
    const r = await spawnCliHeadless(['--turn-timeout', '0']);
    assert.notStrictEqual(r.exitCode, 0);
    assert.match(r.stderr, /turn-timeout/);
  });
});
