import React, { useEffect, useState } from 'react';
import { Text, useInput } from 'ink';
import chalk from 'chalk';

/**
 * Minimal text input. Replaces ink-text-input because that component
 * inserts the letter for any Ctrl+<letter> except Ctrl+C — so Ctrl+T (new
 * tab), Ctrl+W (close), Ctrl+N/P (cycle) ended up typing 't', 'w', 'n', 'p'
 * into the prompt. Child `useInput` listeners fire before parent ones, so
 * an after-the-fact suppression flag wouldn't work either.
 */
interface TextInputProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: (value: string) => void;
  focus?: boolean;
  showCursor?: boolean;
}

export function TextInput({
  value,
  onChange,
  onSubmit,
  focus = true,
  showCursor = true,
}: TextInputProps): React.ReactElement {
  const [cursorOffset, setCursorOffset] = useState(value.length);

  // Clamp cursor when the value shrinks underneath us (e.g. history recall
  // or external clear). Don't snap to end on every change — preserves the
  // offset across edits inside the buffer.
  useEffect(() => {
    setCursorOffset(prev => Math.min(prev, value.length));
  }, [value.length]);

  useInput(
    (input, key) => {
      // Modifiers are reserved for the surrounding app (Ctrl+T/W/N/P, etc.).
      if (key.ctrl || key.meta) return;
      if (key.upArrow || key.downArrow || key.tab) return;
      if (key.return) {
        onSubmit?.(value);
        return;
      }
      if (key.leftArrow) {
        setCursorOffset(o => Math.max(0, o - 1));
        return;
      }
      if (key.rightArrow) {
        setCursorOffset(o => Math.min(value.length, o + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          const next = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
          onChange(next);
          setCursorOffset(o => o - 1);
        }
        return;
      }
      if (input) {
        const next = value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
        onChange(next);
        setCursorOffset(o => o + input.length);
      }
    },
    { isActive: focus },
  );

  let display: string;
  if (showCursor && focus) {
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
