import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  markdownRenderWidth,
  normalizeMarkdown,
  normalizeMarkdownLists,
  renderMarkdown,
} from '../../../src/ui/renderer.js';

describe('markdownRenderWidth', () => {
  it('uses terminal width minus one column', () => {
    assert.strictEqual(markdownRenderWidth(120), 119);
  });

  it('falls back to default width when columns are unavailable', () => {
    assert.strictEqual(markdownRenderWidth(undefined), 79);
  });

  it('clamps invalid narrow widths to one column', () => {
    assert.strictEqual(markdownRenderWidth(0), 1);
  });
});

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

  it('normalizes indented top-level numbered lists and malformed separators', () => {
    const input = [
      '   1. Actual publish path automation',
      '',
      '',
      '     * I don’t see an npm publish/release workflow in .github/workflows/.',
      '',
      '     * Add a release workflow (tag-triggered) to build, test, and npm publish --provenance.',
      '   2. Release notes/changelog process',
      '',
      '',
      '     * No CHANGELOG.md currently.',
      ' ----------------------------------------------------------------------------------------------------------------------------------------------------------',
    ].join('\n');

    const out = normalizeMarkdown(input);
    assert.strictEqual(
      out,
      [
        '1. Actual publish path automation',
        '   * I don’t see an npm publish/release workflow in .github/workflows/.',
        '   * Add a release workflow (tag-triggered) to build, test, and npm publish --provenance.',
        '2. Release notes/changelog process',
        '   * No CHANGELOG.md currently.',
        '',
        '---',
      ].join('\n'),
    );
  });

  it('keeps nested indentation for loose bullets after a paragraph lead-in', () => {
    const input = [
      'Expanded tests significantly to cover new behavior:',
      '',
      '   * New tests for markdownRenderWidth:',
      '',
      '',
      '     * width minus one,',
      '',
      '     * fallback behavior,',
      '',
      '     * narrow-width clamp.',
    ].join('\n');

    const out = normalizeMarkdown(input);
    assert.strictEqual(
      out,
      [
        'Expanded tests significantly to cover new behavior:',
        '',
        '* New tests for markdownRenderWidth:',
        '   * width minus one,',
        '   * fallback behavior,',
        '   * narrow-width clamp.',
      ].join('\n'),
    );
  });
});

describe('renderMarkdown', () => {
  it('keeps nested bullets under ordered lists as bullets', () => {
    const input = [
      '1. Parent one',
      '   * child one',
      '   * child two',
      '2. Parent two',
      '   * child three',
    ].join('\n');

    const out = renderMarkdown(input);
    assert.match(out, /\n\s+\* child one/);
    assert.match(out, /\n\s+\* child two/);
    assert.match(out, /\n\s+\* child three/);
    assert.ok(!/\n\s+\d+\. child two/.test(out));
  });

  it('renders nested bullets with stable indentation from loose markdown', () => {
    const input = [
      'Expanded tests significantly to cover new behavior:',
      '',
      '   * New tests for markdownRenderWidth:',
      '',
      '',
      '     * width minus one,',
      '',
      '     * fallback behavior,',
      '',
      '     * narrow-width clamp.',
    ].join('\n');

    const out = renderMarkdown(input);
    assert.match(out, /^Expanded tests significantly to cover new behavior:/);
    assert.match(out, /\n\s+\* New tests for markdownRenderWidth:/);
    assert.match(out, /\n\s{4}\* width minus one,/);
    assert.match(out, /\n\s{4}\* fallback behavior,/);
    assert.match(out, /\n\s{4}\* narrow-width clamp\./);
  });
});

describe('normalizeMarkdownLists', () => {
  it('removes blank lines between a list item and immediate nested list items', () => {
    const input = ['1. Top item:', '', '   - nested one', '', '   - nested two'].join('\n');
    const out = normalizeMarkdownLists(input);
    assert.strictEqual(out, ['1. Top item:', '   - nested one', '   - nested two'].join('\n'));
  });

  it('removes blank lines between same-indent list siblings (including top-level)', () => {
    const input = ['1. first', '', '2. second'].join('\n');
    const out = normalizeMarkdownLists(input);
    assert.strictEqual(out, ['1. first', '2. second'].join('\n'));
  });

  it('keeps a single blank line when a nested list outdents back to a higher level', () => {
    const input = ['1. parent', '   - child', '', '2. sibling'].join('\n');
    const out = normalizeMarkdownLists(input);
    assert.strictEqual(out, input);
  });

  it('collapses multiple blank lines to one when a nested list outdents', () => {
    const input = ['1. parent', '   - child', '', '', '2. sibling'].join('\n');
    const out = normalizeMarkdownLists(input);
    assert.strictEqual(out, ['1. parent', '   - child', '', '2. sibling'].join('\n'));
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
