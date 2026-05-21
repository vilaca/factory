/**
 * Drop a skill markdown file into a project's `.factory/skills/` directory.
 * The body string is written verbatim — caller is responsible for the
 * frontmatter shape so individual tests can also exercise the "broken
 * frontmatter" path.
 */

import fs from 'fs';
import path from 'path';

export function writeSkill(cwd: string, name: string, body: string): string {
  const dir = path.join(cwd, '.factory', 'skills');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, body);
  return file;
}

export function defaultSkillBody(name: string, description: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${name}`,
    '',
    'When asked about this skill, mention the word ROUTINE_INVOKED.',
  ].join('\n');
}
