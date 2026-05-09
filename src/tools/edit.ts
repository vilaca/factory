import fs from 'fs/promises';
import path from 'path';
import type { ToolContext, ToolDefinition, ToolHandler, ToolResult } from './types.js';
import { TOOL_NAMES } from './types.js';
import { assertPathAllowed, PathDenied } from '../security/paths.js';
import { errorMessage } from '../utils/errors.js';

const definition: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAMES.Edit,
    description:
      'Perform exact string replacement in a file. By default the old_string must appear exactly once; set replace_all=true to replace every occurrence in one call. Use this instead of sed/awk.',
    parameters: {
      type: 'object',
      required: ['file_path', 'old_string', 'new_string'],
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the file to edit',
        },
        old_string: {
          type: 'string',
          description:
            'The exact string to find and replace. Must appear exactly once unless replace_all is true.',
        },
        new_string: {
          type: 'string',
          description: 'The replacement string',
        },
        replace_all: {
          type: 'boolean',
          description:
            'When true, replace every occurrence of old_string. Defaults to false (single unique match required). Prefer this over multiple Edit calls when the intent is a bulk rename.',
        },
      },
    },
  },
};

async function execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const filePath = args.file_path as string;
  const oldString = args.old_string as string;
  const newString = args.new_string as string;
  const replaceAll = args.replace_all === true;

  if (!filePath) return { success: false, output: 'file_path is required' };
  if (!oldString) return { success: false, output: 'old_string is required' };
  if (newString === undefined) return { success: false, output: 'new_string is required' };

  // Resolve relative paths against the per-tab cwd, then enforce the
  // secret-path deny list — see src/tools/read.ts for the rationale.
  const absPath = path.resolve(ctx?.cwd ?? process.cwd(), filePath);
  let resolved: string;
  try {
    resolved = await assertPathAllowed(absPath, ctx?.pathPolicy);
  } catch (err) {
    if (err instanceof PathDenied) return { success: false, output: err.message };
    throw err;
  }

  try {
    const content = await fs.readFile(resolved, { encoding: 'utf-8', signal: ctx?.signal });

    const matchLines = findMatchLines(content, oldString);
    if (matchLines.length >= 1 && (replaceAll || matchLines.length === 1)) {
      // split+join takes new_string literally — String#replace would
      // interpret `$1`, `$&`, `$'`, `` $` ``, `$$` as patterns and mangle
      // replacements containing them (e.g. shell snippets, regex examples,
      // currency-with-dollar-amount). The single-match path used a function
      // replacer for the same reason; split/join generalizes cleanly to N.
      const newContent = content.split(oldString).join(newString);
      const validation = validateStructuredFile(resolved, newContent);
      if (!validation.ok) {
        return rejectStructured(resolved, validation.format, validation.error);
      }
      await fs.writeFile(resolved, newContent, { encoding: 'utf-8', signal: ctx?.signal });
      const count = matchLines.length;
      const noun = count === 1 ? 'occurrence' : 'occurrences';
      return {
        success: true,
        output: `Edited ${resolved}: replaced ${count} ${noun} at line${
          count === 1 ? '' : 's'
        } ${matchLines.join(', ')}`,
      };
    }

    if (matchLines.length > 1) {
      return {
        success: false,
        output:
          `old_string found ${matchLines.length} times in ${resolved} ` +
          `(at lines ${matchLines.join(', ')}) — must be unique. ` +
          `Either include more surrounding context (the line before or after the target) to disambiguate, ` +
          `or set replace_all=true to replace every occurrence in one call.`,
        skipCorrector: true,
      };
    }

    const fuzzy = fuzzyMatch(content, oldString);
    if (fuzzy.kind === 'unique') {
      const adjustedNew = reindent(oldString, fuzzy.matched, newString);
      const newContent = content.replace(fuzzy.matched, () => adjustedNew);
      const validation = validateStructuredFile(resolved, newContent);
      if (!validation.ok) {
        return rejectStructured(resolved, validation.format, validation.error);
      }
      await fs.writeFile(resolved, newContent, { encoding: 'utf-8', signal: ctx?.signal });
      return {
        success: true,
        output:
          `Edited ${resolved}: replaced 1 occurrence at line ${fuzzy.line} ` +
          `(whitespace auto-corrected — old_string indentation didn't match the file exactly).`,
      };
    }
    if (fuzzy.kind === 'ambiguous') {
      return {
        success: false,
        output:
          `old_string not found in ${resolved} (exact match). ` +
          `Whitespace-normalized search found ${fuzzy.count} candidates at lines ${fuzzy.lines.join(', ')} — too ambiguous to auto-correct. ` +
          `Re-read the file and provide old_string with exact indentation.`,
        skipCorrector: true,
      };
    }

    return {
      success: false,
      output:
        `old_string not found in ${resolved}. ` +
        `Re-read the file with the Read tool to get the exact text — ` +
        `whitespace, indentation, and line endings must match exactly.`,
    };
  } catch (err: unknown) {
    return { success: false, output: `Error editing ${resolved}: ${errorMessage(err)}` };
  }
}

type ValidationOk = { ok: true };
type ValidationErr = { ok: false; format: string; error: string };

function validateStructuredFile(filePath: string, content: string): ValidationOk | ValidationErr {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.json')) {
    try {
      JSON.parse(content);
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, format: 'JSON', error: errorMessage(err) };
    }
  }
  return { ok: true };
}

function rejectStructured(filePath: string, format: string, error: string): ToolResult {
  return {
    success: false,
    output:
      `Edit aborted — would produce invalid ${format} in ${filePath}: ${error}. ` +
      `File was NOT modified. ` +
      `Re-read the file, then craft an old_string + new_string pair that preserves ${format} structure (commas between siblings, balanced braces, no literal "\\n" in place of newlines).`,
  };
}

function findMatchLines(content: string, needle: string): number[] {
  // Walk `content` once, advancing a newline counter as we pass each match.
  // Slicing+splitting on every match was O(n²·m) on large files.
  const lines: number[] = [];
  let pos = 0;
  let lineNum = 1;
  let scanned = 0;
  while (true) {
    const idx = content.indexOf(needle, pos);
    if (idx === -1) break;
    while (scanned < idx) {
      if (content.charCodeAt(scanned) === 10) lineNum++;
      scanned++;
    }
    lines.push(lineNum);
    pos = idx + Math.max(needle.length, 1);
  }
  return lines;
}

type FuzzyResult =
  | { kind: 'unique'; matched: string; line: number }
  | { kind: 'ambiguous'; count: number; lines: number[] }
  | { kind: 'none' };

function fuzzyMatch(content: string, oldString: string): FuzzyResult {
  const fileLines = content.split('\n');
  const needleLines = oldString.split('\n');
  // Drop trailing empty lines that come from a final \n in the needle.
  while (needleLines.length > 1 && needleLines[needleLines.length - 1] === '') {
    needleLines.pop();
  }
  if (needleLines.length === 0) return { kind: 'none' };

  const normNeedle = needleLines.map(l => l.trim());
  const matches: number[] = []; // start line indices (0-based)
  for (let i = 0; i + normNeedle.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < normNeedle.length; j++) {
      if (fileLines[i + j]!.trim() !== normNeedle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(i);
  }

  if (matches.length === 1) {
    const start = matches[0]!;
    const matched = fileLines.slice(start, start + normNeedle.length).join('\n');
    return { kind: 'unique', matched, line: start + 1 };
  }
  if (matches.length > 1) {
    return { kind: 'ambiguous', count: matches.length, lines: matches.map(m => m + 1) };
  }
  return { kind: 'none' };
}

function leadingWhitespace(line: string): string {
  return (line.match(/^[ \t]*/) ?? [''])[0];
}

function reindent(oldString: string, matched: string, newString: string): string {
  const oldIndent = leadingWhitespace(oldString.split('\n')[0]!);
  const matchedIndent = leadingWhitespace(matched.split('\n')[0]!);
  if (oldIndent === matchedIndent) return newString;

  const newLines = newString.split('\n');

  if (matchedIndent.length > oldIndent.length) {
    const prefix = matchedIndent.slice(oldIndent.length);
    return newLines
      .map((line, i) => {
        if (i === 0) {
          return line.startsWith(oldIndent) ? matchedIndent + line.slice(oldIndent.length) : line;
        }
        return prefix + line;
      })
      .join('\n');
  }

  const removePrefix = oldIndent.slice(matchedIndent.length);
  return newLines
    .map((line, i) => {
      if (i === 0) {
        return line.startsWith(oldIndent) ? matchedIndent + line.slice(oldIndent.length) : line;
      }
      return line.startsWith(removePrefix) ? line.slice(removePrefix.length) : line;
    })
    .join('\n');
}

export const editTool: ToolHandler = {
  name: TOOL_NAMES.Edit,
  description: definition.function.description,
  category: 'write',
  definition,
  execute,
};
