import { TOOL_NAMES } from '../../tools/types.js';

export function formatArgValue(v: unknown): string {
  const str = typeof v === 'string' ? v : JSON.stringify(v);
  const lines = str.split('\n');
  const firstLine = lines[0] ?? '';
  const moreLines = lines.length > 1 ? ` …${lines.length - 1} more lines` : '';
  const truncated = firstLine.length > 100 ? firstLine.slice(0, 100) + '…' : firstLine;
  return truncated + moreLines;
}

const PRIMARY_ARG_BY_TOOL: Record<string, string> = {
  Bash: 'command',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  NotebookEdit: 'file_path',
  Grep: 'pattern',
  Glob: 'pattern',
  LS: 'path',
  WebFetch: 'url',
  WebSearch: 'query',
};

// Tools whose primary arg is a pattern/regex/glob — wrapping it in quotes makes
// it obvious where the value starts and ends, especially when it contains
// spaces or glob metacharacters.
const QUOTE_PRIMARY_ARG: ReadonlySet<string> = new Set([TOOL_NAMES.Grep, TOOL_NAMES.Glob]);

export function summarizeToolArgs(toolName: string, args: Record<string, unknown>): string {
  const primaryKey = PRIMARY_ARG_BY_TOOL[toolName];
  const value =
    primaryKey && args[primaryKey] !== undefined ? args[primaryKey] : Object.values(args)[0];
  if (value === undefined) return '';
  const formatted = formatArgValue(value);
  return QUOTE_PRIMARY_ARG.has(toolName) ? `'${formatted}'` : formatted;
}
