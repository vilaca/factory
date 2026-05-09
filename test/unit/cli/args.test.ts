import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseArgs, printUsage, printVersion } from '../../../src/cli/args.js';

function captureConsoleLog(fn: () => void): string {
  const original = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(a => String(a)).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return chunks.join('\n');
}

function captureUsage(): string {
  return captureConsoleLog(printUsage);
}

describe('printUsage', () => {
  it('prints the usage banner with the binary name and core flags', () => {
    const output = captureUsage();
    assert.ok(output.includes('Usage:'), 'expected "Usage:" header');
    assert.ok(output.includes('factory'), 'expected binary name "factory"');
    assert.ok(output.includes('--model'), 'expected --model flag in help');
    assert.ok(output.includes('--provider'), 'expected --provider flag in help');
  });

  it('lists huggingface in the providers / examples', () => {
    const output = captureUsage();
    assert.ok(output.includes('huggingface'), 'expected "huggingface" in usage output');
  });

  it('lists copilot with a gpt-4.1 example', () => {
    const output = captureUsage();
    assert.ok(output.includes('copilot'), 'expected "copilot" in usage output');
    assert.ok(output.includes('gpt-4.1'), 'expected "gpt-4.1" copilot example');
  });

  it('shows version, --version, and --debug in usage output', () => {
    const output = captureUsage();
    assert.ok(/v\d/.test(output), 'expected version number in usage banner');
    assert.ok(output.includes('--version'), 'expected --version flag in help');
    assert.ok(output.includes('--debug'), 'expected --debug flag in help');
  });
});

describe('printVersion', () => {
  it('prints "factory <semver>" with no extra noise', () => {
    const output = captureConsoleLog(printVersion);
    assert.match(output, /^factory \d+\.\d+\.\d+(-[\w.]+)?$/);
  });
});

describe('parseArgs', () => {
  it('parses --version and -V', () => {
    assert.strictEqual(parseArgs(['--version']).version, true);
    assert.strictEqual(parseArgs(['-V']).version, true);
  });

  it('parses --debug', () => {
    assert.strictEqual(parseArgs(['--debug']).debug, true);
    assert.strictEqual(parseArgs([]).debug, undefined);
  });

  it('parses --help and -h', () => {
    assert.strictEqual(parseArgs(['--help']).help, true);
    assert.strictEqual(parseArgs(['-h']).help, true);
  });
});
