/**
 * Detect when the model is spinning on near-duplicate Bash commands and
 * inject a corrective nudge so it stops trying micro-variations of the same
 * query and answers (or changes approach) instead.
 *
 * Heuristic:
 *  - keep a rolling window of recent Bash commands
 *  - on each new command, count how many recent ones are "similar"
 *    (token-level Jaccard >= 0.7)
 *  - if the new command matches 2+ recent ones (i.e. it is the 3rd similar
 *    command in the window), fire one nudge per cluster and skip until the
 *    pattern breaks
 */

const RECENT_WINDOW = 5;
// Real-world spinning commands often share ~50–60% of their tokens (same
// `find … -exec … {} \;` skeleton, different middle). 0.7 was too strict.
// TODO: Improve the heuristic for exploratory commands. In session
// 2026-05-02T17-54-07-761Z-a6e6ef, these legitimate investigation sequences
// were flagged as near-duplicates:
//   1. grep -n "JSON.parse" ...
//   2. grep -n "yield { done: true }" ...
//   3. grep -n -A2 "JSON.parse(tc.function.arguments)" ...
//   4. grep -n "finish_reason\|done: true\|yield.*done" ...
// and later:
//   1. npm test 2>&1 | tail -20
//   2. npm test 2>&1 | grep -A 10 "copilot-auth\|copilot-provider" | head -40
//   3. ls dist-test/.../copilot-auth.js && head -10 dist-test/.../copilot-auth.js
//   4. head -5 dist/providers/copilot/auth.js || echo "no dist output"; ls dist/ | head -5
//   5. npm run build 2>&1 && npm test 2>&1 | tail -15
// Consider discounting shared shell scaffolding (`cd ... &&`), and weighting
// the search pattern / target files more heavily than boilerplate. We may also
// want command-family-aware handling so `grep`/inspection sequences and
// `npm test` vs `npm run build && npm test` are not treated like the same loop.
const SIMILARITY_THRESHOLD = 0.5;
const SIMILAR_COUNT_TRIGGER = 2; // i.e. third similar command fires the nudge

export class BashDedupTracker {
  private recent: string[] = [];
  private lastNudgedFor: string | null = null;

  /** Returns true when this command should fire a dedup nudge. */
  observe(command: string): boolean {
    const trimmed = command.trim();
    const matches = this.recent.filter(
      c => jaccardSimilarity(c, trimmed) >= SIMILARITY_THRESHOLD,
    ).length;
    this.recent.push(trimmed);
    if (this.recent.length > RECENT_WINDOW) this.recent.shift();

    if (matches >= SIMILAR_COUNT_TRIGGER) {
      // Don't fire repeatedly for the same near-identical command.
      if (
        this.lastNudgedFor !== null &&
        jaccardSimilarity(this.lastNudgedFor, trimmed) >= SIMILARITY_THRESHOLD
      ) {
        return false;
      }
      this.lastNudgedFor = trimmed;
      return true;
    }
    return false;
  }

  recentCommands(): string[] {
    return [...this.recent];
  }
}

function tokenize(command: string): Set<string> {
  return new Set(command.split(/\s+/).filter(Boolean));
}

function jaccardSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let intersection = 0;
  for (const tok of ta) if (tb.has(tok)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
