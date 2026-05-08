export function formatArgValue(v: unknown): string {
  const str = typeof v === 'string' ? v : JSON.stringify(v);
  const firstLine = str.split('\n')[0] ?? '';
  const moreLines = str.includes('\n') ? ' …' + (str.split('\n').length - 1) + ' more lines' : '';
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

export function summarizeToolArgs(toolName: string, args: Record<string, unknown>): string {
  const primaryKey = PRIMARY_ARG_BY_TOOL[toolName];
  const value =
    primaryKey && args[primaryKey] !== undefined ? args[primaryKey] : Object.values(args)[0];
  if (value === undefined) return '';
  return formatArgValue(value);
}
