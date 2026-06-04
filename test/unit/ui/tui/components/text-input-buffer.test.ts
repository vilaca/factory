import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cursorRowCol,
  deleteBeforeCursor,
  insertAtCursor,
  normalizeNewlines,
  stripNewlines,
  wrapBufferForDisplay,
} from '../../../../../src/ui/tui/components/text-input-buffer.js';

describe('text-input-buffer', () => {
  describe('stripNewlines', () => {
    it('removes CR and LF characters', () => {
      assert.equal(stripNewlines('a\nb\rc\r\nd'), 'abcd');
    });
    it('returns input unchanged when there are none', () => {
      assert.equal(stripNewlines('hello'), 'hello');
    });
  });

  describe('normalizeNewlines', () => {
    it('converts CRLF to LF', () => {
      assert.equal(normalizeNewlines('a\r\nb\r\nc'), 'a\nb\nc');
    });
    it('converts lone CR to LF', () => {
      assert.equal(normalizeNewlines('a\rb\rc'), 'a\nb\nc');
    });
    it('leaves LF alone', () => {
      assert.equal(normalizeNewlines('a\nb\nc'), 'a\nb\nc');
    });
  });

  describe('insertAtCursor (single-line)', () => {
    it('inserts at cursor and advances offset', () => {
      assert.deepEqual(insertAtCursor('helo', 2, 'l', false), {
        value: 'hello',
        cursor: 3,
      });
    });
    it('appends at end', () => {
      assert.deepEqual(insertAtCursor('hi', 2, '!', false), {
        value: 'hi!',
        cursor: 3,
      });
    });
    it('strips embedded newlines from a multi-line paste', () => {
      assert.deepEqual(insertAtCursor('', 0, 'a\nb\r\nc', false), {
        value: 'abc',
        cursor: 3,
      });
    });
    it('is a no-op when the chunk reduces to empty after stripping', () => {
      assert.deepEqual(insertAtCursor('hi', 1, '\n\r\n', false), {
        value: 'hi',
        cursor: 1,
      });
    });
  });

  describe('insertAtCursor (multiline)', () => {
    it('preserves embedded newlines verbatim', () => {
      assert.deepEqual(insertAtCursor('', 0, 'line1\nline2', true), {
        value: 'line1\nline2',
        cursor: 11,
      });
    });
    it('normalises CRLF in pasted content', () => {
      assert.deepEqual(insertAtCursor('', 0, 'a\r\nb', true), {
        value: 'a\nb',
        cursor: 3,
      });
    });
    it('inserts a single newline mid-buffer', () => {
      assert.deepEqual(insertAtCursor('abcd', 2, '\n', true), {
        value: 'ab\ncd',
        cursor: 3,
      });
    });
    it('clamps an out-of-range cursor instead of corrupting the buffer', () => {
      assert.deepEqual(insertAtCursor('hi', 99, 'x', true), {
        value: 'hix',
        cursor: 3,
      });
    });
  });

  describe('deleteBeforeCursor', () => {
    it('removes the character before the cursor', () => {
      assert.deepEqual(deleteBeforeCursor('hello', 5), {
        value: 'hell',
        cursor: 4,
      });
    });
    it('removes a newline (joining two lines)', () => {
      assert.deepEqual(deleteBeforeCursor('a\nb', 2), {
        value: 'ab',
        cursor: 1,
      });
    });
    it('is a no-op at offset 0', () => {
      assert.deepEqual(deleteBeforeCursor('hi', 0), {
        value: 'hi',
        cursor: 0,
      });
    });
  });

  describe('cursorRowCol', () => {
    it('returns row 0 col 0 for empty buffer', () => {
      assert.deepEqual(cursorRowCol('', 0), { row: 0, col: 0 });
    });
    it('places cursor on the first row for offsets within line 1', () => {
      assert.deepEqual(cursorRowCol('hello\nworld', 3), { row: 0, col: 3 });
    });
    it('places cursor on the second row past the newline', () => {
      assert.deepEqual(cursorRowCol('hello\nworld', 8), { row: 1, col: 2 });
    });
    it('places cursor at the start of the second row right after the newline', () => {
      assert.deepEqual(cursorRowCol('hello\nworld', 6), { row: 1, col: 0 });
    });
    it('places cursor at end-of-row when offset == line length', () => {
      assert.deepEqual(cursorRowCol('hello\nworld', 5), { row: 0, col: 5 });
    });
    it('handles a trailing empty line', () => {
      assert.deepEqual(cursorRowCol('hi\n', 3), { row: 1, col: 0 });
    });
    it('clamps an out-of-range offset to the end of the buffer', () => {
      assert.deepEqual(cursorRowCol('hi', 99), { row: 0, col: 2 });
    });
  });

  describe('wrapBufferForDisplay', () => {
    it('wraps long logical rows to the requested display width', () => {
      assert.deepEqual(wrapBufferForDisplay('abcdef', 2, 3), {
        rows: ['abc', 'def'],
        cursor: { row: 0, col: 2 },
      });
    });

    it('moves the cursor to the next visual row at a wrap boundary', () => {
      assert.deepEqual(wrapBufferForDisplay('abcdef', 3, 3), {
        rows: ['abc', 'def'],
        cursor: { row: 1, col: 0 },
      });
    });

    it('adds a cursor-only row at end of a full-width line', () => {
      assert.deepEqual(wrapBufferForDisplay('abc', 3, 3), {
        rows: ['abc', ''],
        cursor: { row: 1, col: 0 },
      });
    });

    it('preserves explicit empty rows', () => {
      assert.deepEqual(wrapBufferForDisplay('a\n\nb', 2, 4), {
        rows: ['a', '', 'b'],
        cursor: { row: 1, col: 0 },
      });
    });

    it('clamps invalid widths to one column', () => {
      assert.deepEqual(wrapBufferForDisplay('ab', 1, 0), {
        rows: ['a', 'b'],
        cursor: { row: 1, col: 0 },
      });
    });
  });
});
