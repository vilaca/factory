/**
 * Detect when a streaming response has fallen into degenerate repetition —
 * the same line emitted over and over (a known small-model failure mode,
 * e.g. ASCII art that gets stuck on a single row of `|         |`).
 *
 * Streams arrive as arbitrary chunks, not aligned to line boundaries, so we
 * accumulate and split on `\n`. Only "complete" lines (i.e. everything before
 * the last newline) are inspected; the trailing partial line is held until
 * the next chunk completes it.
 *
 * Triggers when the same non-trivial line has appeared `threshold` times in
 * a row. Empty lines and very short lines (≤ 1 char) are ignored to avoid
 * false positives on blank-line runs in normal output.
 */
export class RepeatDetector {
  private buffer = '';
  private lastLine: string | null = null;
  private streak = 0;

  constructor(private readonly threshold: number = 50) {}

  /**
   * Feed a streamed text chunk. Returns { line, streak } if a runaway
   * repetition has been detected, or null otherwise.
   */
  feed(chunk: string): { line: string; streak: number } | null {
    this.buffer += chunk;
    let newlineIdx = this.buffer.indexOf('\n');
    while (newlineIdx >= 0) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      const trigger = this.observeLine(line);
      if (trigger) return trigger;
      newlineIdx = this.buffer.indexOf('\n');
    }
    return null;
  }

  private observeLine(line: string): { line: string; streak: number } | null {
    // Skip lines that are blank or trivially short — runs of blank lines or
    // single-character lines aren't a useful signal.
    if (line.trim().length <= 1) {
      this.lastLine = null;
      this.streak = 0;
      return null;
    }
    if (line === this.lastLine) {
      this.streak++;
      if (this.streak >= this.threshold) return { line, streak: this.streak };
    } else {
      this.lastLine = line;
      this.streak = 1;
    }
    return null;
  }
}
