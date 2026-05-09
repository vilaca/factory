import { describe, it } from 'node:test';
import assert from 'node:assert';
import { defaultRegistry } from '../../../src/tools/index.js';

// Deeper Bash paths not covered by tools.test.ts: env scrubbing applied to
// the spawned shell, AbortSignal termination, output truncation cap, the
// $PWD-sentinel cwdAfter mechanism, and the wall-clock timeout actually
// firing on a runaway command.

const bash = defaultRegistry.get('Bash')!;

describe('Bash — env scrubbing', () => {
  it('forwards allowlisted vars (PATH, HOME) to the spawned shell', async () => {
    const result = await bash.execute({ command: 'echo "PATH=$PATH" && echo "HOME=$HOME"' });
    assert.strictEqual(result.success, true);
    assert.match(result.output, /PATH=.+/);
    assert.match(result.output, /HOME=.+/);
  });

  it('hides denylisted vars (FACTORY_*) from the spawned shell', async () => {
    // Set a sentinel on this process; the spawned shell must NOT see it
    // because the FACTORY_ prefix is in the default deny list (env scrub
    // exists precisely so a model-driven `printenv | curl …` cannot
    // exfiltrate process-level secrets).
    process.env.FACTORY_TEST_SECRET = 'should-not-leak';
    try {
      const result = await bash.execute({ command: 'echo "X=${FACTORY_TEST_SECRET:-unset}"' });
      assert.strictEqual(result.success, true);
      assert.match(result.output, /X=unset/);
      assert.ok(!result.output.includes('should-not-leak'));
    } finally {
      delete process.env.FACTORY_TEST_SECRET;
    }
  });

  it('hides unknown (non-allowlisted) vars from the spawned shell', async () => {
    process.env.SOME_RANDOM_VAR_XYZ = 'leak-marker-abc';
    try {
      const result = await bash.execute({
        command: 'echo "X=${SOME_RANDOM_VAR_XYZ:-unset}"',
      });
      assert.strictEqual(result.success, true);
      assert.match(result.output, /X=unset/);
      assert.ok(!result.output.includes('leak-marker-abc'));
    } finally {
      delete process.env.SOME_RANDOM_VAR_XYZ;
    }
  });

  it('user-extended allow list passes through via envPolicy', async () => {
    process.env.MY_CUSTOM_VAR = 'custom-allowed';
    try {
      const result = await bash.execute(
        { command: 'echo "X=${MY_CUSTOM_VAR:-unset}"' },
        { cwd: process.cwd(), envPolicy: { allow: ['MY_CUSTOM_VAR'] } },
      );
      assert.strictEqual(result.success, true);
      assert.match(result.output, /X=custom-allowed/);
    } finally {
      delete process.env.MY_CUSTOM_VAR;
    }
  });
});

describe('Bash — AbortSignal', () => {
  it('terminates a long-running command when the signal aborts mid-flight', async () => {
    const ac = new AbortController();
    // Abort after 50ms; the command would otherwise sleep for 30s.
    setTimeout(() => ac.abort(), 50);
    const t0 = Date.now();
    const result = await bash.execute(
      { command: 'sleep 30' },
      { cwd: process.cwd(), signal: ac.signal },
    );
    const elapsed = Date.now() - t0;
    // Expect the spawn to surface an abort error far below the 30s sleep.
    // 5s is generous to account for slow CI; the sleep would take 30s
    // unaborted, so anything well under that proves termination worked.
    assert.ok(elapsed < 5000, `expected abort to terminate quickly, took ${elapsed}ms`);
    // child_process.spawn with a triggered signal surfaces an 'error' event,
    // which the bash tool resolves as success=false.
    assert.strictEqual(result.success, false);
  });
});

describe('Bash — output cap', () => {
  it('truncates combined stdout/stderr past 50KB and emits a truncation footer', async () => {
    // Use yes(1)-style repetition to exceed the 50,000-byte cap quickly.
    // `head -c 100000` produces 100KB, well over the cap.
    const result = await bash.execute({
      command: 'yes "x" | head -c 100000',
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('...(output truncated)'));
    // The truncated body itself is the cap (50,000) plus the footer.
    assert.ok(result.output.length < 51_000);
  });
});

describe('Bash — cwdAfter sentinel', () => {
  it('does not set cwdAfter when the command leaves the working dir unchanged', async () => {
    const result = await bash.execute({ command: 'true' }, { cwd: process.cwd() });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.cwdAfter, undefined);
  });

  it('reports the new cwd when the command cd-s into a different directory', async () => {
    // sh -c interprets `cd /tmp && pwd` in the same shell as the wrapper's
    // post-command `printf "$PWD"`, so the wrapper sees the post-cd value.
    const result = await bash.execute(
      { command: 'cd /tmp' },
      { cwd: process.cwd() },
    );
    assert.strictEqual(result.success, true);
    // On macOS /tmp is a symlink into /private/tmp; accept either form.
    assert.ok(
      result.cwdAfter === '/tmp' || result.cwdAfter === '/private/tmp',
      `unexpected cwdAfter: ${result.cwdAfter ?? '<undefined>'}`,
    );
  });

  it('does not leak the sentinel marker into the visible output', async () => {
    const result = await bash.execute({ command: 'cd /tmp' }, { cwd: process.cwd() });
    assert.strictEqual(result.success, true);
    // The wrapper's marker prefix must be stripped before returning to the model.
    assert.ok(!result.output.includes('__FACTORY_CWD_AFTER__'));
  });

  it('does not misparse a user command that legitimately prints the static prefix', async () => {
    // The marker line uses a per-invocation nonce, so a command that echoes
    // the static prefix (without the nonce) must NOT be eaten by the
    // sentinel regex. The literal output should reach the user.
    const result = await bash.execute({
      command: 'echo "__FACTORY_CWD_AFTER__not-a-real-marker:/fake"',
    });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('__FACTORY_CWD_AFTER__not-a-real-marker:/fake'));
    // And cwdAfter should remain unset because no real (nonce-tagged) marker fired.
    assert.strictEqual(result.cwdAfter, undefined);
  });
});

describe('Bash — wall-clock timeout', () => {
  it('terminates a runaway command at the configured timeout', async () => {
    const t0 = Date.now();
    // 1s timeout; sleep would take 10s. Node's spawn timeout sends SIGTERM
    // and the 'error' handler fires, so the call resolves quickly.
    const result = await bash.execute({ command: 'sleep 10', timeout: 1000 });
    const elapsed = Date.now() - t0;
    // Must terminate well under the 10s sleep; allow generous CI slack.
    assert.ok(elapsed < 5000, `timeout did not fire in time: ${elapsed}ms`);
    // The exact resolution shape (success/error) depends on platform signal
    // handling; the contract under test is "doesn't hang the agent loop".
    assert.ok(typeof result.success === 'boolean');
  });
});
