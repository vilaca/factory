import type { RunRefs } from './types.js';

export function recordHistory(refs: { current: RunRefs | null }, text: string): void {
  if (!refs.current) return;
  refs.current.historyIndex = -1;
  refs.current.historyDraft = '';
  const h = refs.current.pastHistory;
  if (text && h[0] !== text) {
    h.unshift(text);
  }
}

export function historyUp(
  refs: { current: RunRefs | null },
  currentInput: string,
): string | null {
  if (!refs.current) return null;
  const history = refs.current.pastHistory;
  if (history.length === 0) return null;
  if (refs.current.historyIndex === -1) {
    refs.current.historyDraft = currentInput;
    refs.current.historyIndex = 0;
  } else if (refs.current.historyIndex < history.length - 1) {
    refs.current.historyIndex++;
  }
  return history[refs.current.historyIndex];
}

export function historyDown(refs: { current: RunRefs | null }): string | null {
  if (!refs.current) return null;
  if (refs.current.historyIndex === -1) return null;
  if (refs.current.historyIndex > 0) {
    refs.current.historyIndex--;
    return refs.current.pastHistory[refs.current.historyIndex];
  }
  refs.current.historyIndex = -1;
  return refs.current.historyDraft;
}
