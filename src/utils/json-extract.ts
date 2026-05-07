// Shared brace-depth scanner for finding top-level JSON objects in a
// string. Two parsers in src/core/ used to maintain near-identical copies
// of this state machine; consolidating means a fix to string-escape or
// nesting handling lands in one place.

/**
 * Yield `[start, end)` ranges of top-level balanced JSON objects in
 * `text`. `text.slice(start, end)` is the substring of one object,
 * including the outer braces. Braces inside string literals are skipped
 * via a small string/escape state machine.
 *
 * The scanner does not validate that each slice is parseable JSON — that
 * is up to the caller (a corrector wants to bail on parse failure; a
 * harvester might want to collect raw substrings and parse later).
 *
 * On a stray closing brace at depth 0, the scanner resets and continues
 * rather than throwing. Malformed input is the common case here, not the
 * exception, and the caller can re-validate the result.
 */
function* iterateJsonObjectRanges(text: string): Generator<{ start: number; end: number }> {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        yield { start, end: i + 1 };
        start = -1;
      } else if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }
}

/** Collect every top-level balanced JSON object substring in `text`. */
export function extractAllJsonObjects(text: string): string[] {
  const out: string[] = [];
  for (const r of iterateJsonObjectRanges(text)) {
    out.push(text.slice(r.start, r.end));
  }
  return out;
}

/**
 * Slice the first balanced JSON object substring out of `text` and parse
 * it. Returns null if no balanced object is found or if the first one
 * fails to parse — by design it does NOT scan past a malformed first
 * match (keeps the corrector behavior we depend on; a harvester that
 * wants tolerant parsing should iterate ranges manually).
 */
export function parseFirstJsonObject<T = Record<string, unknown>>(text: string): T | null {
  const it = iterateJsonObjectRanges(text);
  const first = it.next();
  if (first.done) return null;
  try {
    return JSON.parse(text.slice(first.value.start, first.value.end)) as T;
  } catch {
    return null;
  }
}
