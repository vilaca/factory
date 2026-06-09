import type { Skill } from './loader.js';
import { loadSkillBody } from './loader.js';
import { renderSkill } from './render.js';
import { pushSkillScope } from './permissions.js';
import type { SkillsRegistry } from './index.js';
import type { PermissionManager } from '../../security/permissions.js';

export interface InvokeContext {
  registry: SkillsRegistry;
  permissions: PermissionManager;
  /** Current working directory — used for path restrictions and shell cmds. */
  cwd: string;
  /** Whether !\`cmd\` shell injection is enabled (from experimental config). */
  shellInjectionEnabled?: boolean;
  /**
   * Inject rendered content as a system message into the current
   * conversation turn. The caller owns the conversation and decides how
   * to insert it (typically as a `[System: ...]` user message before the
   * next model call).
   */
  injectSystemMessage: (text: string) => void;
  /**
   * Run a skill in a forked sub-agent context. Returns the sub-agent's
   * final answer as plain text. Used when `skill.context === 'fork'`.
   * If not provided, fork skills fall back to current-context injection.
   */
  runSubagent?: (opts: SubagentOpts) => Promise<string>;
}

interface SubagentOpts {
  task: string;
  agentType?: string;
  model?: string;
}

export type InvokeResult =
  | { kind: 'injected'; content: string }
  | { kind: 'delegated'; summary: string }
  | { kind: 'not-found' }
  | { kind: 'path-restricted' }
  | { kind: 'model-invocation-disabled' };

/**
 * Invoke a skill by name. Orchestrates: lookup → path check → body load
 * → render → permission scope → execute (inject or fork).
 */
export async function invokeSkill(
  name: string,
  args: string,
  ctx: InvokeContext,
): Promise<InvokeResult> {
  const skill = ctx.registry.find(name);
  if (!skill) return { kind: 'not-found' };

  // Path restriction: if the skill declares `paths`, cwd must match one.
  if (skill.paths.length > 0 && !matchesPaths(ctx.cwd, skill.paths)) {
    return { kind: 'path-restricted' };
  }

  // Load body on first invocation (lazy).
  const body = await loadSkillBody(skill);

  // Render: arg substitution + optional shell injection.
  const rendered = await renderSkill(skill, body, args, {
    shellInjectionEnabled: ctx.shellInjectionEnabled ?? true,
    cwd: ctx.cwd,
  });

  // Push permission scope; pop in finally so errors never leave stale state.
  const pop = pushSkillScope(ctx.permissions, {
    allowed: skill.allowedTools,
    disallowed: skill.disallowedTools,
  });

  try {
    if (skill.context === 'fork' && ctx.runSubagent) {
      const summary = await ctx.runSubagent({
        task: rendered,
        agentType: skill.agent,
        model: skill.model,
      });
      return { kind: 'delegated', summary };
    }

    // Default: inject into current context.
    const injection = formatSkillInjection(skill, rendered);
    ctx.injectSystemMessage(injection);
    return { kind: 'injected', content: injection };
  } finally {
    pop();
  }
}

function formatSkillInjection(skill: Skill, rendered: string): string {
  return `## Skill: ${skill.name}\n${rendered}`;
}

/**
 * Minimally check whether `cwd` matches any of the glob patterns in
 * `paths`. We do a simple prefix/suffix check without a glob library to
 * keep the dep surface minimal: a pattern like `src/**` matches any cwd
 * that contains `src/` as a segment; an absolute pattern must be a prefix.
 */
function matchesPaths(cwd: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    // Absolute patterns: cwd must start with the literal prefix.
    if (pattern.startsWith('/')) {
      const prefix = pattern.replace(/\*.*$/, '');
      return cwd.startsWith(prefix);
    }
    // Relative patterns: just check if the pattern stem appears in cwd.
    const stem = pattern.replace(/\*.*$/, '').replace(/\/$/, '');
    if (!stem) return true;
    return cwd.includes(`/${stem}/`) || cwd.includes(`/${stem}`) || cwd.endsWith(`/${stem}`);
  });
}
