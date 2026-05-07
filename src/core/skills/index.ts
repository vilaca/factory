import type { Skill } from './loader.js';
import { loadSkills } from './loader.js';
import { shouldInjectSkill, type MatchContext } from './matcher.js';

export { loadSkills };

/**
 * In-memory registry created once per session. Owns the list of loaded skills,
 * keeps track of which conditional skills have already been injected so a
 * trigger that fires twice in a row doesn't double-inject the same body, and
 * exposes the per-turn evaluation entry point.
 */
export class SkillsRegistry {
  private readonly skills: Skill[];
  private readonly recentToolNames: string[] = [];
  private readonly RECENT_TOOL_WINDOW = 5;
  /** Last body injected per skill — used to suppress immediate-repeat injections. */
  private readonly lastInjectedBody = new Map<string, string>();

  constructor(skills: Skill[]) {
    this.skills = skills;
  }

  /** All loaded skills (for /skills, /skill <name>). */
  list(): readonly Skill[] {
    return this.skills;
  }

  find(name: string): Skill | undefined {
    return this.skills.find(s => s.name === name);
  }

  /**
   * Concatenated bodies of every alwaysOn skill, joined by blank lines, ready
   * to be appended under a `## Skills` heading in the system prompt.
   */
  alwaysOnSection(): string {
    const on = this.skills.filter(s => s.alwaysOn);
    if (on.length === 0) return '';
    const parts = on.map(s => `### ${s.name}\n${s.body}`);
    return `## Skills\n${parts.join('\n\n')}`;
  }

  /**
   * Track a tool used during the turn. We keep a rolling window so triggers
   * with `tools:` constraints can intersect against the recent-call history.
   */
  recordToolUsed(name: string): void {
    this.recentToolNames.push(name);
    if (this.recentToolNames.length > this.RECENT_TOOL_WINDOW) {
      this.recentToolNames.shift();
    }
  }

  /**
   * Evaluate every conditional skill and return the bodies that should be
   * injected this turn. De-duplicates against the previous injection so a
   * skill firing twice in succession isn't injected twice.
   */
  evaluate(userMessage: string): { skill: Skill; body: string }[] {
    const ctx: MatchContext = { userMessage, recentToolNames: [...this.recentToolNames] };
    const out: { skill: Skill; body: string }[] = [];
    for (const skill of this.skills) {
      if (!shouldInjectSkill(skill, ctx)) continue;
      const previous = this.lastInjectedBody.get(skill.name);
      if (previous === skill.body) continue;
      this.lastInjectedBody.set(skill.name, skill.body);
      out.push({ skill, body: skill.body });
    }
    return out;
  }

  /**
   * Format the matched bodies as one consolidated system message. Returns
   * empty string when nothing matched.
   */
  formatInjection(matches: { skill: Skill; body: string }[]): string {
    if (matches.length === 0) return '';
    const parts = matches.map(m => `### ${m.skill.name}\n${m.body}`);
    return `## Skills (auto-injected)\n${parts.join('\n\n')}`;
  }
}
