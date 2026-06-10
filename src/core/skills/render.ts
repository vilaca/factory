import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Skill } from './loader.js';

const execFileAsync = promisify(execFile);

const SHELL_INJECTION_MAX_BUFFER = 256 * 1024; // 256 KB
const SHELL_INJECTION_TIMEOUT_MS = 10_000;

export interface RenderOpts {
  /** Whether !\`cmd\` blocks are executed. Default true. */
  shellInjectionEnabled?: boolean;
  /** Working directory for shell commands. */
  cwd?: string;
}

/**
 * Render a skill body for invocation:
 * 1. Argument substitution ($ARGUMENTS, $0..$9, named args).
 * 2. Shell injection — !\`cmd\` inline and !\`\`\`block\`\`\`.
 */
export async function renderSkill(
  skill: Skill,
  body: string,
  args: string,
  opts: RenderOpts = {},
): Promise<string> {
  const positional = splitShellArgs(args);
  let rendered = substituteArgs(body, args, positional, skill.argumentNames);

  const shellEnabled = opts.shellInjectionEnabled ?? true;
  if (shellEnabled) {
    rendered = await runShellInjections(rendered, skill.shell, opts.cwd);
  }

  return rendered;
}

// ---------- Argument substitution ----------

function substituteArgs(
  body: string,
  rawArgs: string,
  positional: string[],
  namedArgs: string[],
): string {
  let result = body;

  // $ARGUMENTS → full raw arg string
  result = result.replace(/\$ARGUMENTS(?!\[)/g, rawArgs);

  // $ARGUMENTS[n] → positional[n]
  result = result.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, idx: string) => {
    return positional[parseInt(idx, 10)] ?? '';
  });

  // $0 .. $9 → positional[n]
  result = result.replace(/\$([0-9])/g, (_, n: string) => {
    return positional[parseInt(n, 10)] ?? '';
  });

  // Named args: for each name in skill.argumentNames, $name → positional[i]
  for (let i = 0; i < namedArgs.length; i++) {
    const name = namedArgs[i];
    if (!name) continue;
    // Only replace whole-word occurrences so $issue doesn't eat $issues_count.
    const re = new RegExp(`\\$${escapeRegex(name)}(?![A-Za-z0-9_])`, 'g');
    const value = positional[i] ?? '';
    result = result.replace(re, value);
  }

  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- Shell injection ----------

const BLOCK_PATTERN = /!```(?:[^\n]*)?\n([\s\S]*?)```/g;
const INLINE_PATTERN = /!`([^`]+)`/g;

async function runShellInjections(
  body: string,
  shell: string | undefined,
  cwd: string | undefined,
): Promise<string> {
  // Process block injections first (they contain backticks that would
  // confuse the inline pattern).
  let result = body;
  const blockMatches = [...result.matchAll(BLOCK_PATTERN)];
  for (const match of blockMatches.reverse()) {
    const cmd = match[1]?.trim() ?? '';
    const replacement = await runCommand(cmd, shell, cwd);
    result =
      result.slice(0, match.index!) + replacement + result.slice(match.index! + match[0].length);
  }

  // Inline injections.
  const inlineMatches = [...result.matchAll(INLINE_PATTERN)];
  for (const match of inlineMatches.reverse()) {
    const cmd = match[1]?.trim() ?? '';
    const replacement = await runCommand(cmd, shell, cwd);
    result =
      result.slice(0, match.index!) + replacement + result.slice(match.index! + match[0].length);
  }

  return result;
}

async function runCommand(
  cmd: string,
  shell: string | undefined,
  cwd: string | undefined,
): Promise<string> {
  if (!cmd) return '';
  const interpreter = shell ?? 'sh';
  try {
    const { stdout } = await execFileAsync(interpreter, ['-c', cmd], {
      timeout: SHELL_INJECTION_TIMEOUT_MS,
      maxBuffer: SHELL_INJECTION_MAX_BUFFER,
      ...(cwd ? { cwd } : {}),
    });
    return stdout.trimEnd();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `<error: ${msg}>`;
  }
}

// ---------- Shell-style arg splitter ----------

/**
 * Split a raw argument string into positional tokens using simple shell-style
 * quoting (single/double quotes, backslash escapes). No external dep.
 */
function splitShellArgs(raw: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const s = raw.trim();

  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    const { token, next } = readToken(s, i);
    tokens.push(token);
    i = next;
  }

  return tokens;
}

function readToken(s: string, start: number): { token: string; next: number } {
  const q = s[start];
  if (q === '"') return readDoubleQuoted(s, start + 1);
  if (q === "'") return readSingleQuoted(s, start + 1);
  return readUnquoted(s, start);
}

function readDoubleQuoted(s: string, i: number): { token: string; next: number } {
  let token = '';
  while (i < s.length && s[i] !== '"') {
    if (s[i] === '\\' && i + 1 < s.length) {
      i++;
      token += s[i]!;
    } else token += s[i]!;
    i++;
  }
  return { token, next: i + 1 }; // skip closing "
}

function readSingleQuoted(s: string, i: number): { token: string; next: number } {
  let token = '';
  while (i < s.length && s[i] !== "'") {
    token += s[i]!;
    i++;
  }
  return { token, next: i + 1 }; // skip closing '
}

function readUnquoted(s: string, i: number): { token: string; next: number } {
  let token = '';
  while (i < s.length && !/\s/.test(s[i]!)) {
    if (s[i] === '\\' && i + 1 < s.length) {
      i++;
      token += s[i]!;
    } else token += s[i]!;
    i++;
  }
  return { token, next: i };
}
