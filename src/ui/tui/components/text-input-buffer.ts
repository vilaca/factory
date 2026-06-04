/**
 * Pure, side-effect-free buffer math for `TextInput`. Kept out of the
 * component so the multi-line behaviour can be unit-tested without an
 * Ink rendering harness.
 */

export interface BufferState {
  value: string;
  cursor: number;
}

/** Strip all CR/LF so single-line callers (e.g. the API-token field in
 *  the provider picker) never end up with embedded newlines, even if a
 *  paste somehow leaks past `usePaste`. */
export function stripNewlines(text: string): string {
  return text.replace(/[\r\n]+/g, '');
}

/** Normalise CRLF / lone CR to LF so the buffer only ever stores `\n`. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Insert `chunk` at `cursor`, returning the new value and cursor offset.
 *  When `multiline` is false, embedded newlines are removed. */
export function insertAtCursor(
  value: string,
  cursor: number,
  chunk: string,
  multiline: boolean,
): BufferState {
  const sanitized = multiline ? normalizeNewlines(chunk) : stripNewlines(chunk);
  if (!sanitized) return { value, cursor };
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const next = value.slice(0, safeCursor) + sanitized + value.slice(safeCursor);
  return { value: next, cursor: safeCursor + sanitized.length };
}

/** Delete the character before the cursor (Backspace). No-op at offset 0. */
export function deleteBeforeCursor(value: string, cursor: number): BufferState {
  if (cursor <= 0) return { value, cursor: 0 };
  const safeCursor = Math.min(cursor, value.length);
  const next = value.slice(0, safeCursor - 1) + value.slice(safeCursor);
  return { value: next, cursor: safeCursor - 1 };
}

export interface RowCol {
  row: number;
  col: number;
}

export interface WrappedBuffer {
  rows: string[];
  cursor: RowCol;
}

/** Translate a flat character offset into a (row, col) pair for a
 *  newline-delimited buffer. Always returns a valid row/col, even for
 *  out-of-range offsets. */
export function cursorRowCol(value: string, cursor: number): RowCol {
  const rows = value.split('\n');
  const clamped = Math.max(0, Math.min(cursor, value.length));
  let remaining = clamped;
  for (let i = 0; i < rows.length; i++) {
    const len = rows[i]!.length;
    if (remaining <= len) return { row: i, col: remaining };
    remaining -= len + 1;
  }
  // Fall-through (only reachable if `value` is empty): row 0, col 0.
  return { row: 0, col: 0 };
}

/** Split the buffer into the same visual rows the terminal will paint when
 *  constrained to `width` columns, and place the cursor in that visual grid.
 *  The input remains offset-based; wrapping is only a render concern. */
export function wrapBufferForDisplay(value: string, cursor: number, width: number): WrappedBuffer {
  const maxWidth = Math.max(1, Math.floor(width));
  const clamped = Math.max(0, Math.min(cursor, value.length));
  const logicalRows = value.split('\n');
  const rows: string[] = [];
  let cursorPos: RowCol | undefined;
  let offset = 0;

  for (let rowIndex = 0; rowIndex < logicalRows.length; rowIndex++) {
    const line = logicalRows[rowIndex]!;
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    const firstVisualRow = rows.length;
    const chunks =
      line.length === 0
        ? ['']
        : Array.from({ length: Math.ceil(line.length / maxWidth) }, (_, i) =>
            line.slice(i * maxWidth, (i + 1) * maxWidth),
          );

    rows.push(...chunks);

    if (clamped >= lineStart && clamped <= lineEnd) {
      const colInLine = clamped - lineStart;
      if (colInLine > 0 && colInLine % maxWidth === 0) {
        const visualRow = firstVisualRow + colInLine / maxWidth;
        if (visualRow === rows.length) rows.push('');
        cursorPos = { row: visualRow, col: 0 };
      } else {
        cursorPos = {
          row: firstVisualRow + Math.floor(colInLine / maxWidth),
          col: colInLine % maxWidth,
        };
      }
    }

    offset = lineEnd + 1;
  }

  return {
    rows,
    cursor: cursorPos ?? { row: 0, col: 0 },
  };
}
