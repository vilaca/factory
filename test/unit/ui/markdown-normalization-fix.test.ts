import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeTopLevelListIndentation } from '../../../src/ui/markdown.js';

describe('normalizeTopLevelListIndentation - regression test for Invalid string length', () => {
  it('should handle lines that match shouldNormalize* conditions but fail regex match', () => {
    // These are edge cases that could cause the original bug
    const edgeCases = [
      // Empty lines
      '',
      '   ',
      '    ',
      // Lines with only whitespace and list markers but no content
      '   -',
      '    -',
      '   1.',
      '    1.',
      // Lines with invalid list marker formats that might pass shouldNormalize* but fail regex
      '   *without space',
      '    *without space',
      '   1without dot',
      '    1without dot',
      // Mixed content that might confuse the logic
      '   -item without space',
      '    -item without space',
    ];

    for (const input of edgeCases) {
      // Should not throw "Invalid string length" error
      const result = normalizeTopLevelListIndentation([input]);
      assert.doesNotThrow(() => {
        // Try to join the result to ensure it creates valid strings
        const joined = result.join('\n');
        assert.ok(typeof joined === 'string', `Result should be a string, got ${typeof joined}`);
        assert.ok(joined.length >= 0, `String length should be valid, got ${joined.length}`);
      }, `Failed on input: "${input}"`);
    }
  });

  it('should handle complex mixed indentation scenarios without crashing', () => {
    const complexCases = [
      ['   - valid top level', '    *invalid nested (no space after *)', '   - another top level'],
      ['   1. valid ordered', '    2invalid (no dot)', '   2. another ordered'],
      ['    - potential nested', '   - top level', '     *invalid deep nested'],
    ];

    for (const inputLines of complexCases) {
      assert.doesNotThrow(
        () => {
          const result = normalizeTopLevelListIndentation(inputLines);
          const joined = result.join('\n');
          // Basic validation that we got a reasonable result
          assert.ok(joined.length >= 0);
          assert.ok(!joined.includes('undefined'));
          assert.ok(!joined.includes('null'));
        },
        `Failed on input: ${JSON.stringify(inputLines)}`,
      );
    }
  });

  it('should preserve original line when regex fails but shouldNormalize returns true', () => {
    // This specifically tests the fix: when shouldNormalize* returns true
    // but the regex fails, we should fall back to the original line
    const lines = [
      '   *invalid marker', // shouldNormalize might return true, but regex will fail
    ];

    const result = normalizeTopLevelListIndentation(lines);
    const joined = result.join('\n');

    // Should not crash and should preserve the original content
    assert.ok(joined.includes('*invalid marker'));
    assert.ok(!joined.includes('undefined'));
    assert.ok(joined.length > 0);
  });

  it('should handle null bytes and special characters safely', () => {
    // Test with various special characters that might cause string issues
    const specialCases = [
      '   - item with \\x00 null byte',
      '    - item with \\u0000 unicode null',
      '   - item with emoji 🚀',
      '    - item with multiple   spaces',
      '   - item with\ttabs',
    ];

    for (const input of specialCases) {
      assert.doesNotThrow(() => {
        const result = normalizeTopLevelListIndentation([input]);
        const joined = result.join('\n');
        assert.ok(typeof joined === 'string');
        assert.ok(joined.length >= 0);
      }, `Failed on special case: "${input}"`);
    }
  });
});
