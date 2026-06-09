import path from 'path';
import os from 'os';
import type { Dirent } from 'fs';
import fs from 'fs/promises';
import type { AgentConfig, PluginConfig } from '../config/types.js';

/**
 * One discovery root for skills. Each scope has a directory; the loader
 * walks it looking for `<dir>/<skill-name>/SKILL.md` entries. `pluginName`
 * is set only for plugin scopes; loaded skills under that scope are
 * namespaced `<pluginName>:<skill-name>` so they can never collide with
 * the three user-visible scopes (enterprise / personal / project).
 */
export interface SkillScope {
  kind: 'enterprise' | 'personal' | 'project' | 'plugin';
  root: string;
  pluginName?: string;
}

const SKILLS_SUBDIR = path.join('.factory', 'skills');

/**
 * Resolve every scope dir that may hold skills, in **precedence order**
 * (lowest priority first, so the loader's `Map.set()` merge yields:
 *
 *   project < personal < enterprise
 *
 * — matching the spec §4 precedence rule "Enterprise > Personal > Project"
 * once the map is built). Plugin scopes are namespaced and never merged
 * by raw name, so they live in their own slot order-independent.
 *
 * Missing directories don't throw — they just don't contribute. The
 * loader sees the empty list and continues.
 */
export async function resolveScopes(cwd: string, config?: AgentConfig): Promise<SkillScope[]> {
  const scopes: SkillScope[] = [];

  // Project — lowest priority (overridden by personal+enterprise).
  scopes.push({ kind: 'project', root: path.join(cwd, SKILLS_SUBDIR) });

  // Personal.
  scopes.push({ kind: 'personal', root: path.join(os.homedir(), SKILLS_SUBDIR) });

  // Enterprise — highest priority. Sourced from env or config.
  const enterpriseDir =
    process.env.FACTORY_ENTERPRISE_SKILLS_DIR?.trim() ?? config?.enterprise?.skillsDir?.trim();
  if (enterpriseDir) {
    scopes.push({ kind: 'enterprise', root: enterpriseDir });
  }

  // Plugins — namespaced; never collide with the above. Each plugin
  // contributes its own scope; entries are namespaced by `pluginName`.
  for (const plugin of (config?.plugins ?? []) as PluginConfig[]) {
    if (!plugin?.name || !plugin?.root) continue;
    scopes.push({
      kind: 'plugin',
      pluginName: plugin.name,
      root: path.join(plugin.root, 'skills'),
    });
  }

  return scopes;
}

/**
 * Detect flat-layout legacy skills (`<scope>/foo.md`) under personal /
 * project scopes so the loader can emit a single migration warning per
 * legacy file. The spec drops flat-file support; flat files are NOT
 * loaded — only reported.
 */
export async function findLegacyFlatSkills(scope: SkillScope): Promise<string[]> {
  if (scope.kind === 'plugin') return [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(scope.root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => path.join(scope.root, e.name));
}
