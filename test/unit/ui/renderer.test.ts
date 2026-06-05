import { describe, it } from 'node:test';
import assert from 'node:assert';
import { normalizeMarkdown, normalizeMarkdownLists } from '../../../src/ui/renderer.js';

describe('normalizeMarkdown', () => {
  it('canonicalizes long dash separators and inserts a blank line before them', () => {
    const input = [
      '3. historyDown(refs)',
      '---------------------------------------------------------------------',
    ].join('\n');
    const out = normalizeMarkdown(input);
    assert.strictEqual(out, ['3. historyDown(refs)', '', '---'].join('\n'));
  });

  it('collapses repeated blank lines outside fences while preserving fenced content', () => {
    const input = [
      '2. historyUp(refs, currentInput)',
      '',
      '',
      '   - Handles pressing Up.',
      '```md',
      'line 1',
      '',
      '',
      'line 2',
      '```',
    ].join('\n');

    const out = normalizeMarkdown(input);
    assert.strictEqual(
      out,
      [
        '2. historyUp(refs, currentInput)',
        '   - Handles pressing Up.',
        '```md',
        'line 1',
        '',
        '',
        'line 2',
        '```',
      ].join('\n'),
    );
  });
});

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
