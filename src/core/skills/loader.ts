import type { Dirent } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import type { AgentConfig } from '../config/types.js';
import { resolveScopes, findLegacyFlatSkills, type SkillScope } from './scopes.js';
import { errorMessage } from '../../utils/errors.js';

/**
 * Full skill record. Fields are populated in two phases:
 *  - Phase 1 (metadata): everything except `body`. `metadataOnly` is true.
 *  - Phase 2 (body): `loadSkillBody()` fills `body` and clears `metadataOnly`.
 */
export interface Skill {
  name: string;
  description: string;
  whenToUse?: string;
  argumentHint?: string;
  argumentNames: string[];
  allowedTools: string[];
  disallowedTools: string[];
  disableModelInvocation: boolean;
  userInvocable: boolean;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  context: 'current' | 'fork';
  agent?: string;
  paths: string[];
  shell?: string;
  alwaysOn: boolean;
  scope: 'enterprise' | 'personal' | 'project' | 'plugin';
  pluginName?: string;
  /** Absolute path to the directory containing SKILL.md. */
  sourceDir: string;
  metadataOnly: boolean;
  body?: string;
}

export interface SkillLoadResult {
  skills: Skill[];
  warnings: string[];
}

const SKILL_FILE = 'SKILL.md';

/**
 * Load skills from all configured scopes. Project < Personal < Enterprise
 * (enterprise wins on name collision). Plugin skills are namespaced and
 * never collide with the three user scopes.
 */
export async function loadSkills(cwd: string, config?: AgentConfig): Promise<SkillLoadResult> {
  const warnings: string[] = [];
  const scopes = await resolveScopes(cwd, config);

  // Check for legacy flat files and warn.
  for (const scope of scopes) {
    const legacy = await findLegacyFlatSkills(scope);
    for (const file of legacy) {
      const base = path.basename(file, '.md');
      const dir = path.dirname(file);
      warnings.push(
        `"${file}" is a flat skill file — directory-per-skill layout required. ` +
          `Run: mkdir -p "${path.join(dir, base)}" && mv "${file}" "${path.join(dir, base, SKILL_FILE)}"`,
      );
    }
  }

  // Build a map in precedence order: project → personal → enterprise.
  // Each successive scope overwrites the previous for the same name.
  // Plugins are namespaced so they never overwrite.
  const byName = new Map<string, Skill>();

  for (const scope of scopes) {
    const { skills, warnings: sw } = await loadSkillsFromScope(scope);
    for (const w of sw) warnings.push(w);
    for (const skill of skills) {
      byName.set(skill.name, skill);
    }
  }

  return { skills: [...byName.values()], warnings };
}

async function loadSkillsFromScope(
  scope: SkillScope,
): Promise<{ skills: Skill[]; warnings: string[] }> {
  const warnings: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(scope.root, { withFileTypes: true });
  } catch {
    return { skills: [], warnings };
  }

  const skillDirs = entries.filter(e => e.isDirectory());
  const results = await Promise.all(
    skillDirs.map(async entry => {
      const dir = path.join(scope.root, entry.name);
      const skillFile = path.join(dir, SKILL_FILE);
      let raw: string;
      try {
        raw = await fs.readFile(skillFile, 'utf-8');
      } catch {
        return null; // No SKILL.md — silently skip (non-skill dir).
      }
      try {
        return loadSkillMetadata(raw, dir, scope);
      } catch (err) {
        warnings.push(`${skillFile}: ${errorMessage(err)}`);
        return null;
      }
    }),
  );

  const skills: Skill[] = [];
  for (const r of results) {
    if (r) skills.push(r);
  }
  return { skills, warnings };
}

/**
 * Parse frontmatter only — body is intentionally discarded. The registry
 * holds metadata-only skills; call `loadSkillBody()` to populate the body
 * on first invocation.
 */
export function loadSkillMetadata(raw: string, sourceDir: string, scope: SkillScope): Skill {
  const split = splitFrontmatter(raw);
  if (!split) {
    throw new Error('missing YAML frontmatter (expected file to start with ---)');
  }
  const fm = parseFrontmatter(split.frontmatter);
  const name = resolveSkillName(fm, sourceDir, scope);
  const fields = parseSkillFields(fm);
  const scopeKind = scope.kind;
  const pluginName = scope.kind === 'plugin' ? scope.pluginName : undefined;

  return {
    name,
    ...fields,
    scope: scopeKind,
    ...(pluginName !== undefined ? { pluginName } : {}),
    sourceDir,
    metadataOnly: true,
  };
}

function resolveSkillName(
  fm: Record<string, FmValue>,
  sourceDir: string,
  scope: SkillScope,
): string {
  const rawName = (fm['name'] as string | undefined) ?? path.basename(sourceDir);
  const name =
    scope.kind === 'plugin' && scope.pluginName ? `${scope.pluginName}:${rawName}` : rawName;
  if (!/^[a-z0-9][a-z0-9:_-]*$/.test(name)) {
    throw new Error(`skill name must be kebab-case (got "${name}")`);
  }
  return name;
}

type SkillFields = Omit<
  Skill,
  'name' | 'scope' | 'pluginName' | 'sourceDir' | 'metadataOnly' | 'body'
>;

function parseSkillFields(fm: Record<string, FmValue>): SkillFields {
  const description = getString(fm, 'description') ?? '';
  const whenToUse = getOptionalString(fm, 'when_to_use') ?? getOptionalString(fm, 'whenToUse');
  const argumentHint =
    getOptionalString(fm, 'argument-hint') ?? getOptionalString(fm, 'argumentHint');
  const argumentNames = getStringArray(fm, 'arguments') ?? [];
  const allowedTools =
    getStringArray(fm, 'allowed-tools') ?? getStringArray(fm, 'allowedTools') ?? [];
  const disallowedTools =
    getStringArray(fm, 'disallowed-tools') ?? getStringArray(fm, 'disallowedTools') ?? [];
  const disableModelInvocation = getBoolean(fm, 'disable-model-invocation') ?? false;
  const userInvocable = getBoolean(fm, 'user-invocable') ?? true;
  const model = getOptionalString(fm, 'model');
  const effort = parseEffort(getOptionalString(fm, 'effort'));
  const context = parseContext(getOptionalString(fm, 'context') ?? 'current');
  const agent = getOptionalString(fm, 'agent');
  const paths = getStringArray(fm, 'paths') ?? [];
  const shell = getOptionalString(fm, 'shell');
  const alwaysOn = getBoolean(fm, 'alwaysOn') ?? getBoolean(fm, 'always-on') ?? false;

  return {
    description,
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    ...(argumentHint !== undefined ? { argumentHint } : {}),
    argumentNames,
    allowedTools,
    disallowedTools,
    disableModelInvocation,
    userInvocable,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    context,
    ...(agent !== undefined ? { agent } : {}),
    paths,
    ...(shell !== undefined ? { shell } : {}),
    alwaysOn,
  };
}

function parseEffort(raw: string | undefined): 'low' | 'medium' | 'high' | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  throw new Error(`"effort" must be "low", "medium", or "high" (got "${raw}")`);
}

function parseContext(raw: string): 'current' | 'fork' {
  if (raw === 'current' || raw === 'fork') return raw;
  throw new Error(`"context" must be "current" or "fork" (got "${raw}")`);
}

/**
 * Read and return the body of a skill. Caches by storing `body` on the
 * skill record and clearing `metadataOnly`. Safe to call multiple times —
 * subsequent calls return the cached body immediately.
 */
export async function loadSkillBody(skill: Skill): Promise<string> {
  if (!skill.metadataOnly && skill.body !== undefined) return skill.body;
  const skillFile = path.join(skill.sourceDir, SKILL_FILE);
  const raw = await fs.readFile(skillFile, 'utf-8');
  const split = splitFrontmatter(raw);
  const body = split ? split.body.trim() : raw.trim();
  skill.body = body;
  skill.metadataOnly = false;
  return body;
}

// ---------- Frontmatter split + parser ----------

interface Split {
  frontmatter: string;
  body: string;
}

function splitFrontmatter(raw: string): Split | null {
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
 * Tiny YAML-ish parser. No external dep — same intentional constraint as
 * the original. Supports scalars, booleans, inline arrays `[a, b]`, and
 * block lists `- item`. Extends the original to allow hyphens in keys
 * (needed for `allowed-tools`, `disable-model-invocation`, etc.).
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
    // Allow hyphens in key names (e.g. `allowed-tools`, `when_to_use`).
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!m) {
      throw new Error(`malformed frontmatter line: "${line}"`);
    }
    const key = m[1]!;
    const rest = m[2];

    if (rest === '' || rest === undefined) {
      const list: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i]!;
        if (/^\s*-\s+/.test(next)) {
          list.push(parseScalar(next.replace(/^\s*-\s+/, '')));
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
      return inner.replace(/\\(["\\nt])/g, (_, c: string) => {
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

// ---------- Typed field accessors ----------

function getString(fm: Record<string, FmValue>, key: string): string | undefined {
  const v = fm[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new Error(`"${key}" must be a string`);
  return v;
}

function getOptionalString(fm: Record<string, FmValue>, key: string): string | undefined {
  return getString(fm, key);
}

function getBoolean(fm: Record<string, FmValue>, key: string): boolean | undefined {
  const v = fm[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new Error(`"${key}" must be a boolean`);
  return v;
}

function getStringArray(fm: Record<string, FmValue>, key: string): string[] | undefined {
  const v = fm[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new Error(`"${key}" must be an array of strings`);
  return v as string[];
}
