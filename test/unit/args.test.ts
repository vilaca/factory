import { describe, it } from 'node:test';
import assert from 'node:assert';
import { printUsage } from '../../src/cli/args.js';

function captureUsage(): string {
  const original = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(a => String(a)).join(' '));
  };
  try {
    printUsage();
  } finally {
    console.log = original;
  }
  return chunks.join('\n');
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
});
