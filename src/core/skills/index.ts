import type { Skill } from './loader.js';
import { loadSkills } from './loader.js';

export { loadSkills };

/**
 * In-memory registry created once per session. Holds metadata-only Skill
 * records; bodies are loaded lazily on first invocation via `loadSkillBody`.
 *
 * The old regex-trigger evaluate() path is retired — skill activation is
 * now model-driven via the `invoke_skill` tool. The registry's job is to:
 *  - hold the loaded skill catalog
 *  - expose it for system-prompt catalog injection
 *  - service `find()` calls from slash dispatch and invoke.ts
 *  - produce the `alwaysOnSection()` that is inlined into the system prompt
 */
export class SkillsRegistry {
  private readonly skills: Skill[];

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
   * Catalog section injected into the system prompt for all skills where
   * `!disableModelInvocation`. Each line is:
   *   - <name> — <description>[. Use when: <when_to_use>]
   * The model reads this and calls `invoke_skill` when appropriate.
   */
  catalogSection(): string {
    const visible = this.skills.filter(s => !s.disableModelInvocation);
    if (visible.length === 0) return '';
    const lines = visible.map(s => {
      const base = `- ${s.name} — ${s.description}`;
      return s.whenToUse ? `${base}. Use when: ${s.whenToUse}` : base;
    });
    return `## Skills\n\nYou have access to the following skills. Invoke them with the \`invoke_skill\` tool when the user's request matches.\n\n${lines.join('\n')}`;
  }

  /**
   * Concatenated bodies of every alwaysOn skill, joined by blank lines,
   * ready to be appended under a `## Skills (always-on)` heading in the
   * system prompt. These skills are inlined verbatim so they're always
   * in context — lazy loading doesn't apply to them.
   */
  alwaysOnSection(): string {
    const on = this.skills.filter(s => s.alwaysOn && s.body !== undefined);
    if (on.length === 0) return '';
    const parts = on.map(s => `### ${s.name}\n${s.body}`);
    return `## Skills (always-on)\n${parts.join('\n\n')}`;
  }

  /** @deprecated — no-op stub kept so any external callers don't crash
   *  while the transition lands. Remove once all callers are migrated. */
  recordToolUsed(_name: string): void {
    // model-driven path: tool tracking is no longer needed
  }

  /** @deprecated — returns [] always; model-driven path replaces this. */
  evaluate(_userMessage: string): { skill: Skill; body: string }[] {
    return [];
  }

  /** @deprecated — returns '' always. */
  formatInjection(_matches: { skill: Skill; body: string }[]): string {
    return '';
  }
}
