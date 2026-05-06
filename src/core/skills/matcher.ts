import type { Skill } from './loader.js';

export interface MatchContext {
  /** The latest user message text. */
  userMessage: string;
  /** Tool names used in the last few turns (most-recent-last). */
  recentToolNames: string[];
}

/**
 * Decide whether a non-alwaysOn skill should fire this turn.
 *
 * Semantics (intentionally simple — match OpenHands microagents):
 * - if the skill has triggers, the user message must match at least one (regex, OR semantics, case-insensitive)
 * - if the skill also has tools, at least one of those tools must appear in `recentToolNames`
 * - if a skill has only `tools` (no triggers), the recent-tool intersection alone fires it
 * - a skill with no triggers AND no tools will never fire from here (use alwaysOn for that)
 */
export function shouldInjectSkill(skill: Skill, ctx: MatchContext): boolean {
  if (skill.alwaysOn) return false;

  const hasTriggers = skill.triggers.length > 0;
  const hasTools = skill.tools.length > 0;
  if (!hasTriggers && !hasTools) return false;

  if (hasTriggers) {
    let matched = false;
    for (const pattern of skill.triggers) {
      try {
        const re = new RegExp(pattern, 'i');
        if (re.test(ctx.userMessage)) { matched = true; break; }
      } catch {
        // shouldn't happen — loader pre-validates patterns — but stay defensive
      }
    }
    if (!matched) return false;
  }

  if (hasTools) {
    const recentSet = new Set(ctx.recentToolNames);
    const overlap = skill.tools.some(t => recentSet.has(t));
    if (!overlap) return false;
  }

  return true;
}
