import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { errorMessage } from '../../utils/errors.js';

/**
 * One parsed skill ready for matching/injection. `sourcePath` is kept around
 * for diagnostic messages and for the `/skill <name>` slash command.
 */
export interface Skill {
  name: string;
  description: string;
  alwaysOn: boolean;
  /** Compiled regex sources (the raw strings from frontmatter). */
  triggers: string[];
  /** Tool names; when set, only inject when one was used recently. */
  tools: string[];
  body: string;
  sourcePath: string;
  /** "global" or "project". Project shadows global by skill name. */
  scope: 'global' | 'project';
}

interface SkillLoadResult {
  skills: Skill[];
  /** One per malformed/skipped file, surfaced via the session log. */
  warnings: string[];
}

const SKILLS_SUBDIR = path.join('.factory', 'skills');

/**
 * Load skills from `~/.factory/skills/*.md` (global) and `<cwd>/.factory/skills/*.md`
 * (project). Project entries override global entries that share the same `name`.
 * Malformed files are skipped — they accumulate as warnings instead of throwing,
 * since one bad file shouldn't kill startup.
 */
export async function loadSkills(cwd: string): Promise<SkillLoadResult> {
  const warnings: string[] = [];
  const globalDir = path.join(os.homedir(), SKILLS_SUBDIR);
  const projectDir = path.join(cwd, SKILLS_SUBDIR);

  const [globalSkills, projectSkills] = await Promise.all([
    loadSkillsFromDir(globalDir, 'global', warnings),
    loadSkillsFromDir(projectDir, 'project', warnings),
  ]);

  // Project overrides global by name. Build a map seeded from globals, then
  // overwrite with project entries.
  const byName = new Map<string, Skill>();
  for (const s of globalSkills) byName.set(s.name, s);
  for (const s of projectSkills) byName.set(s.name, s);

  return { skills: [...byName.values()], warnings };
}

async function loadSkillsFromDir(
  dir: string,
  scope: 'global' | 'project',
  warnings: string[],
): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const mdEntries = entries.filter(e => e.endsWith('.md'));
  const reads = await Promise.all(
    mdEntries.map(async entry => {
      const filePath = path.join(dir, entry);
      try {
        return { filePath, raw: await fs.readFile(filePath, 'utf-8') };
      } catch {
        return null;
      }
    }),
  );
  const out: Skill[] = [];
  for (const r of reads) {
    if (!r) continue;
    try {
      const skill = parseSkillFile(r.raw, r.filePath, scope);
      if (skill) out.push(skill);
    } catch (err: unknown) {
      warnings.push(`${r.filePath}: ${errorMessage(err)}`);
    }
  }
  return out;
}

/**
 * Split a skill markdown file into frontmatter + body, parse the
 * frontmatter, validate the schema, return a Skill (or throw).
 */
export function parseSkillFile(
  raw: string,
  sourcePath: string,
  scope: 'global' | 'project',
): Skill | null {
  const split = splitFrontmatter(raw);
  if (!split) {
    throw new Error('missing YAML frontmatter (expected file to start with ---)');
  }
  const fm = parseFrontmatter(split.frontmatter);

  const name = fm.name;
  if (typeof name !== 'string' || !name) {
    throw new Error('"name" is required and must be a string');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`"name" must be kebab-case (got "${name}")`);
  }
  const description = fm.description;
  if (typeof description !== 'string' || !description) {
    throw new Error('"description" is required and must be a string');
  }

  const alwaysOn = fm.alwaysOn ?? false;
  if (typeof alwaysOn !== 'boolean') {
    throw new Error('"alwaysOn" must be a boolean');
  }

  const triggers = fm.triggers ?? [];
  if (!Array.isArray(triggers) || !triggers.every(t => typeof t === 'string')) {
    throw new Error('"triggers" must be an array of strings');
  }
  // Validate regex compiles upfront so a bad pattern is caught at load time
  // rather than every turn.
  for (const t of triggers as string[]) {
    try {
      new RegExp(t, 'i');
    } catch (e: unknown) {
      throw new Error(`invalid regex in "triggers": ${t} (${errorMessage(e)})`);
    }
  }

  const tools = fm.tools ?? [];
  if (!Array.isArray(tools) || !tools.every(t => typeof t === 'string')) {
    throw new Error('"tools" must be an array of strings');
  }

  return {
    name,
    description,
    alwaysOn,
    triggers: triggers as string[],
    tools: tools as string[],
    body: split.body.trim(),
    sourcePath,
    scope,
  };
}

interface Split {
  frontmatter: string;
  body: string;
}

function splitFrontmatter(raw: string): Split | null {
  // Allow optional BOM and leading whitespace; require --- on its own line at the top.
  const text = raw.replace(/^﻿/, '');
  if (!/^---\s*\r?\n/.test(text)) return null;
  const afterFirst = text.replace(/^---\s*\r?\n/, '');
  const closeIdx = afterFirst.search(/\r?\n---\s*(\r?\n|$)/);
  if (closeIdx === -1) return null;
  const frontmatter = afterFirst.slice(0, closeIdx);
  const body = afterFirst.slice(closeIdx).replace(/^\r?\n---\s*(\r?\n)?/, '');
  return { frontmatter, body };
}

type FmValue = string | boolean | string[];

/**
 * Tiny YAML-ish parser. We intentionally don't depend on a real YAML library
 * because the skill schema is small: scalar strings, booleans, and string
 * arrays (block list with `- ` or inline `[a, b]`). Anything else throws.
 */
export function parseFrontmatter(text: string): Record<string, FmValue> {
  const out: Record<string, FmValue> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) {
      throw new Error(`malformed frontmatter line: "${line}"`);
    }
    const key = m[1]!;
    const rest = m[2];

    if (rest === '' || rest === undefined) {
      // Block list expected on following lines, indented with `- `.
      const list: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i]!;
        if (/^\s*-\s+/.test(next)) {
          const value = next.replace(/^\s*-\s+/, '');
          list.push(parseScalar(value));
          i++;
        } else if (next.trim() === '') {
          i++;
        } else {
          break;
        }
      }
      out[key] = list;
      continue;
    }

    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      const list = inner === '' ? [] : splitTopLevelCommas(inner).map(s => parseScalar(s.trim()));
      out[key] = list;
      i++;
      continue;
    }

    out[key] = parseScalarOrBool(rest);
    i++;
  }
  return out;
}

function parseScalarOrBool(raw: string): string | boolean {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return parseScalar(trimmed);
}

function parseScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const inner = trimmed.slice(1, -1);
    if (trimmed.startsWith('"')) {
      // Minimal escape handling — \\, \", \n, \t. Anything else passes through.
      return inner.replace(/\\(["\\nt])/g, (_, c) => {
        if (c === 'n') return '\n';
        if (c === 't') return '\t';
        return c;
      });
    }
    return inner;
  }
  return trimmed;
}

function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      buf += ch + s[i + 1];
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === ',' && !inSingle && !inDouble) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0 || parts.length > 0) parts.push(buf);
  return parts;
}
