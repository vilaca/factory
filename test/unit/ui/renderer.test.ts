import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeMarkdownLists } from '../../../src/ui/renderer.js';

describe('normalizeMarkdownLists', () => {
  it('removes blank lines between a list item and immediate nested list items', () => {
    const input = ['1. Top item:', '', '   - nested one', '', '   - nested two'].join('\n');
    const out = normalizeMarkdownLists(input);
    assert.strictEqual(out, ['1. Top item:', '   - nested one', '   - nested two'].join('\n'));
  });

  it('keeps blank lines between top-level list siblings', () => {
    const input = ['1. first', '', '2. second'].join('\n');
    const out = normalizeMarkdownLists(input);
    assert.strictEqual(out, input);
  });

  it('does not normalize content inside fenced code blocks', () => {
    const input = [
      '1. Steps:',
      '',
      '   - Run this:',
      '```md',
      '3. File Loading:',
      '',
      '   - Looks for files',
      '```',
    ].join('\n');

    const out = normalizeMarkdownLists(input);
    assert.strictEqual(
      out,
      [
        '1. Steps:',
        '   - Run this:',
        '```md',
        '3. File Loading:',
        '',
        '   - Looks for files',
        '```',
      ].join('\n'),
    );
  });
});
