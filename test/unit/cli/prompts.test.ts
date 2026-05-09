import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isExitSelection } from '../../../src/cli/prompts.js';

describe('isExitSelection', () => {
  it('treats "0" as exit', () => {
    assert.strictEqual(isExitSelection('0'), true);
    assert.strictEqual(isExitSelection('  0 '), true);
  });

  it('treats "q", "quit", and "exit" as exit (case-insensitive)', () => {
    for (const v of ['q', 'Q', 'quit', 'QUIT', 'Quit', 'exit', 'EXIT', 'Exit']) {
      assert.strictEqual(isExitSelection(v), true, `expected "${v}" to be exit`);
    }
  });

  it('trims surrounding whitespace before classifying', () => {
    assert.strictEqual(isExitSelection('  q  '), true);
    assert.strictEqual(isExitSelection('\tquit\n'), true);
  });

  it('does not treat normal selections as exit', () => {
    for (const v of ['1', '2', '5', 'B', 'anthropic', 'yes', '', 'qq', 'exit-something']) {
      assert.strictEqual(isExitSelection(v), false, `expected "${v}" to NOT be exit`);
    }
  });
});

// `exitStartupSelection` calls process.exit and prints to stdout — covering it
// would require either monkey-patching process.exit or spawning a subprocess.
// Skipping: the function is two lines, exercised in practice by the CLI, and
// doesn't justify the harness complexity.

// `promptText` reads from stdin via readline. Faithful coverage means writing
// to a fake TTY (it asserts on raw mode for the secret variant). The e2e
// suite already exercises both code paths (HF token prompt + Copilot device
// flow), so unit-level mocking would duplicate work without adding signal.
