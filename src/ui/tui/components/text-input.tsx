import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import chalk from 'chalk';
import { deleteBeforeCursor, insertAtCursor, wrapBufferForDisplay } from './text-input-buffer.js';

/**
 * Minimal text input. Replaces ink-text-input because that component
 * inserts the letter for any Ctrl+<letter> except Ctrl+C — so Ctrl+T (new
 * tab), Ctrl+W (close), Ctrl+N/P (cycle) ended up typing 't', 'w', 'n', 'p'
 * into the prompt. Child `useInput` listeners fire before parent ones, so
 * an after-the-fact suppression flag wouldn't work either.
 *
 * Multi-line behaviour (when `multiline` is true):
 *   - `usePaste` captures pasted blocks as one string with newlines intact,
 *     instead of letting the first `\n` trigger Enter and clip the rest.
 *   - Alt+Enter inserts a literal newline; plain Enter still submits.
 *   - The buffer is rendered as a vertical stack of rows so the cursor
 *     can be highlighted on the correct row/column. Applying chalk.inverse
 *     across an embedded `\n` would otherwise produce broken output.
 */
interface TextInputProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: (value: string) => void;
  focus?: boolean;
  showCursor?: boolean;
  /** Allow the buffer to span multiple lines. Defaults to false so the
   *  API-token field in the provider picker stays single-line. */
  multiline?: boolean;
  /** Width available for the editable text, excluding prompt/prefix cells. */
  width?: number;
}

export function TextInput({
  value,
  onChange,
  onSubmit,
  focus = true,
  showCursor = true,
  multiline = false,
  width,
}: TextInputProps): React.ReactElement {
  const [cursorOffset, setCursorOffset] = useState(value.length);

  // Mirror `value` and `cursorOffset` in refs so the handlers below always
  // see the latest committed state even when multiple stdin events fire
  // within the same Node tick (e.g. paste followed by a keystroke). Reading
  // directly from the closure variables would cause the second handler to
  // run against pre-paste state, dropping characters or jumping the cursor.
  // After each applied edit we also write through to the refs so the next
  // event in the same tick observes the new buffer immediately, before
  // React has had a chance to commit and re-register the handlers.
  const valueRef = useRef(value);
  valueRef.current = value;
  const cursorRef = useRef(cursorOffset);
  cursorRef.current = cursorOffset;

  const applyEdit = (nextValue: string, nextCursor: number): void => {
    valueRef.current = nextValue;
    cursorRef.current = nextCursor;
    onChange(nextValue);
    setCursorOffset(nextCursor);
  };

  const moveCursor = (nextCursor: number): void => {
    cursorRef.current = nextCursor;
    setCursorOffset(nextCursor);
  };

  // Clamp cursor when the value shrinks underneath us (e.g. history recall
  // or external clear). Don't snap to end on every change — preserves the
  // offset across edits inside the buffer.
  useEffect(() => {
    setCursorOffset(prev => Math.min(prev, value.length));
  }, [value.length]);

  useInput(
    (input, key) => {
      const v = valueRef.current;
      const c = cursorRef.current;
      // Alt+Enter inserts a newline in multiline mode. Special-cased
      // before the modifier filter so the meta flag doesn't bounce out.
      if (multiline && key.return && key.meta) {
        const next = insertAtCursor(v, c, '\n', true);
        applyEdit(next.value, next.cursor);
        return;
      }
      // Modifiers are reserved for the surrounding app (Ctrl+T/W/N/P, etc.).
      if (key.ctrl || key.meta) return;
      if (key.upArrow || key.downArrow || key.tab) return;
      if (key.return) {
        onSubmit?.(v);
        return;
      }
      if (key.leftArrow) {
        moveCursor(Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        moveCursor(Math.min(v.length, c + 1));
        return;
      }
      if (key.backspace || key.delete) {
        const next = deleteBeforeCursor(v, c);
        if (next.value !== v) applyEdit(next.value, next.cursor);
        return;
      }
      if (input) {
        const next = insertAtCursor(v, c, input, multiline);
        if (next.value !== v) applyEdit(next.value, next.cursor);
      }
    },
    { isActive: focus },
  );

  // Bracketed-paste channel. Always active so a chunky paste isn't
  // misparsed as a flurry of key events; in single-line mode we still
  // strip newlines to preserve the existing contract.
  usePaste(
    text => {
      const v = valueRef.current;
      const c = cursorRef.current;
      const next = insertAtCursor(v, c, text, multiline);
      if (next.value !== v) applyEdit(next.value, next.cursor);
    },
    { isActive: focus },
  );

  const showCursorNow = showCursor && focus;

  if (!multiline) {
    let display: string;
    if (showCursorNow) {
      if (cursorOffset >= value.length) {
        display = value + chalk.inverse(' ');
      } else {
        display =
          value.slice(0, cursorOffset) +
          chalk.inverse(value[cursorOffset]) +
          value.slice(cursorOffset + 1);
      }
    } else {
      display = value;
    }
    return <Text>{display}</Text>;
  }

  const displayWidth = Math.max(1, Math.floor(width ?? 80));
  const { rows, cursor } = wrapBufferForDisplay(value, cursorOffset, displayWidth);
  const { row, col } = cursor;

  return (
    <Box flexDirection="column" width={displayWidth}>
      {rows.map((line, i) => {
        let content: string;
        if (showCursorNow && i === row) {
          if (col >= line.length) {
            content = line + chalk.inverse(' ');
          } else {
            content = line.slice(0, col) + chalk.inverse(line[col]) + line.slice(col + 1);
          }
        } else {
          // Render empty rows as a single space so they still consume a
          // line of vertical space (Ink would otherwise collapse them).
          content = line.length === 0 ? ' ' : line;
        }
        return <Text key={i}>{content}</Text>;
      })}
    </Box>
  );
}
