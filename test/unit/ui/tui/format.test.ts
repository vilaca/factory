import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatArgValue, summarizeToolArgs } from '../../../../src/ui/tui/format.js';
import { TOOL_NAMES } from '../../../../src/tools/types.js';

describe('formatArgValue', () => {
  it('truncates long strings at 100 characters by default', () => {
    const longString = 'a'.repeat(150);
    const result = formatArgValue(longString);
    assert.strictEqual(result.length, 101); // 100 chars + ellipsis
    assert.match(result, /a{100}…/);
  });

  it('does not truncate strings shorter than 100 characters', () => {
    const shortString = 'a'.repeat(50);
    const result = formatArgValue(shortString);
    assert.strictEqual(result, shortString);
  });

  it('uses 1000 character limit for Bash commands', () => {
    const longBashCommand = 'cd /some/path && command with arguments '.repeat(15); // 900 chars
    const result = formatArgValue(longBashCommand, TOOL_NAMES.Bash);
    assert.strictEqual(result.length, longBashCommand.length); // Should not truncate
  });

  it('truncates Bash commands only when they exceed 1000 characters', () => {
    const baseCommand = 'cd /some/path && command ';
    const repeatCount = 60; // This should create a string > 1000 chars
    const veryLongBashCommand = baseCommand.repeat(repeatCount);
    const result = formatArgValue(veryLongBashCommand, TOOL_NAMES.Bash);
    assert.strictEqual(result.length, 1001); // 1000 chars + ellipsis
    assert.match(result, /…$/);
  });

  it('handles multi-line strings correctly', () => {
    const multiLineString = 'line1\nline2\nline3';
    const result = formatArgValue(multiLineString);
    assert.match(result, /line1/);
    assert.match(result, /…2 more lines/);
  });

  it('handles non-string values', () => {
    const obj = { key: 'value', nested: { deep: 'data' } };
    const result = formatArgValue(obj);
    const parsed = JSON.parse(result.replace(/…$/, ''));
    assert.deepStrictEqual(parsed, obj);
  });
});

describe('summarizeToolArgs', () => {
  it('returns empty string for empty args', () => {
    const result = summarizeToolArgs('Bash', {});
    assert.strictEqual(result, '');
  });

  it('extracts primary arg for known tools', () => {
    const args = { command: 'echo hello', other: 'ignored' };
    const result = summarizeToolArgs(TOOL_NAMES.Bash, args);
    assert.strictEqual(result, 'echo hello');
  });

  it('uses first arg value for unknown tools', () => {
    const args = { unknownKey: 'value1', otherKey: 'value2' };
    const result = summarizeToolArgs('UnknownTool', args);
    assert.strictEqual(result, 'value1');
  });

  it('handles long bash commands without truncation', () => {
    const longCommand =
      'cd /Users/vilaca/work/factory/main && npx prettier --write test/unit/ui/markdown-normalization-fix.test.ts test/unit/ui/another-very-long-file-name-that-makes-the-command-exceed-100-characters.test.ts';
    const args = { command: longCommand };
    const result = summarizeToolArgs(TOOL_NAMES.Bash, args);
    assert.strictEqual(result, longCommand);
    assert.strictEqual(result.length, longCommand.length);
  });

  it('wraps Grep and Glob patterns in quotes', () => {
    const grepArgs = { pattern: 'test.*\\.ts' };
    const result = summarizeToolArgs(TOOL_NAMES.Grep, grepArgs);
    assert.strictEqual(result, `'test.*\\.ts'`);
  });

  it('does not wrap non-pattern tools in quotes', () => {
    const bashArgs = { command: 'echo hello' };
    const result = summarizeToolArgs(TOOL_NAMES.Bash, bashArgs);
    assert.strictEqual(result, 'echo hello');
  });
});
