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
