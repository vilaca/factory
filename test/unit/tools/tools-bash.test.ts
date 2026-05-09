import { describe, it } from 'node:test';
import assert from 'node:assert';
import { defaultRegistry } from '../../../src/tools/index.js';
import { __testing as bashTesting } from '../../../src/tools/bash.js';

describe('Bash tool', () => {
  const bash = defaultRegistry.get('Bash')!;

  it('executes command and returns stdout', async () => {
    const result = await bash.execute({ command: 'echo hello' });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('hello'));
  });

  it('returns stderr alongside non-zero exit, but still success', async () => {
    const result = await bash.execute({ command: 'ls /nonexistent_dir_xyz' });
    // Command ran; non-zero exit is informational, not a tool failure.
    assert.strictEqual(result.success, true);
    assert.match(result.output, /exit code/);
  });

  it('fails for missing command', async () => {
    const result = await bash.execute({});
    assert.strictEqual(result.success, false);
    assert.ok(result.output.includes('required'));
  });

  it('captures exit code 0 as success with no exit-code header', async () => {
    const result = await bash.execute({ command: 'true' });
    assert.strictEqual(result.success, true);
    assert.doesNotMatch(result.output, /exit code/);
  });

  it('non-zero exit reports success=true with exit code in output', async () => {
    const result = await bash.execute({ command: 'false' });
    assert.strictEqual(result.success, true);
    assert.match(result.output, /exit code 1/);
  });

  // The following pin down the documented behavior: Bash invokes /bin/sh -c
  // with no parsing or quoting, so all shell metacharacters work as expected.
  // If we ever add a sanitizer/parser, these flip to negative assertions.

  it('$(...) command substitution is evaluated by /bin/sh', async () => {
    const result = await bash.execute({ command: 'echo $(echo nested)' });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('nested'));
  });

  it('backtick command substitution is evaluated by /bin/sh', async () => {
    const result = await bash.execute({ command: 'echo `echo back`' });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('back'));
  });

  it('; chains multiple commands', async () => {
    const result = await bash.execute({ command: 'echo first; echo second' });
    assert.strictEqual(result.success, true);
    assert.ok(result.output.includes('first'));
    assert.ok(result.output.includes('second'));
  });

  it('pipes stdout between commands', async () => {
    const result = await bash.execute({ command: 'printf "a\\nb\\nc\\n" | wc -l' });
    assert.strictEqual(result.success, true);
    assert.match(result.output, /\b3\b/);
  });

  it('clamps the timeout parameter to [MIN, MAX]', () => {
    const { clampTimeout, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } = bashTesting;
    // Invalid input (non-finite, non-numeric) → default. Pretending to honor
    // ±Infinity by clamping to MAX/MIN would mask a malformed model call.
    assert.strictEqual(clampTimeout(undefined), DEFAULT_TIMEOUT_MS);
    assert.strictEqual(clampTimeout(null), DEFAULT_TIMEOUT_MS);
    assert.strictEqual(clampTimeout(NaN), DEFAULT_TIMEOUT_MS);
    assert.strictEqual(clampTimeout(Infinity), DEFAULT_TIMEOUT_MS);
    assert.strictEqual(clampTimeout(-Infinity), DEFAULT_TIMEOUT_MS);
    assert.strictEqual(clampTimeout('not a number'), DEFAULT_TIMEOUT_MS);
    // Finite values clamp to [MIN, MAX]. 0 would otherwise disable the
    // timeout entirely (Node treats falsy as no timeout) — the main reason
    // we clamp at all.
    assert.strictEqual(clampTimeout(0), MIN_TIMEOUT_MS);
    assert.strictEqual(clampTimeout(-5000), MIN_TIMEOUT_MS);
    assert.strictEqual(clampTimeout(MAX_TIMEOUT_MS + 1), MAX_TIMEOUT_MS);
    assert.strictEqual(clampTimeout(5000), 5000);
  });
});
