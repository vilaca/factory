import fs from 'fs/promises';
import { glob as fsGlob } from 'fs/promises';
import path from 'path';
import type { ToolContext, ToolDefinition, ToolHandler, ToolResult } from './types.js';

// Convenience filter to skip the heaviest dirs by default. Not exhaustive
// (build outputs like dist/, .next/, coverage/ are not listed) and not a
// security boundary — if a caller needs tighter scoping, pass a more
// specific `path` or `pattern`.
const EXCLUDE_DIR_SEGMENTS = new Set(['node_modules', '.git']);

// Cap on returned results. The model rarely benefits from more than a few
// dozen file paths in one go; 500 is generous headroom and keeps the
// formatted output below the per-tool-result token cap.
const MAX_RESULTS = 500;

const definition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'Glob',
    description: 'Find files matching a glob pattern (e.g. "**/*.ts", "src/**/*.js"). Returns file paths sorted by modification time. Use this instead of find or ls.',
    parameters: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: {
          type: 'string',
          description: 'The glob pattern to match files against',
        },
        path: {
          type: 'string',
          description: 'Directory to search in. Defaults to current working directory.',
        },
      },
    },
  },
};

async function execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const searchPath = (args.path as string) ?? ctx?.cwd ?? process.cwd();

  if (!pattern) {
    return { success: false, output: 'pattern is required' };
  }

  try {
    const matches: { file: string; mtime: number }[] = [];
    for await (const file of fsGlob(pattern, {
      cwd: searchPath,
      exclude: (p: string) => p.split(path.sep).some(seg => EXCLUDE_DIR_SEGMENTS.has(seg)),
    })) {
      const fullPath = path.resolve(searchPath, file);
      try {
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) continue;
        matches.push({ file, mtime: stat.mtimeMs });
      } catch {
        // unreadable entry — skip it
      }
    }

    matches.sort((a, b) => b.mtime - a.mtime);
    const result = matches.map(m => m.file);

    if (result.length === 0) {
      return { success: true, output: 'No files matched the pattern.', empty: true };
    }

    const truncated = result.length > MAX_RESULTS
      ? [...result.slice(0, MAX_RESULTS), `\n... (${result.length - MAX_RESULTS} more files)`]
      : result;

    return { success: true, output: truncated.join('\n') };
  } catch (err: any) {
    return { success: false, output: `Glob error: ${err.message}` };
  }
}

export const globTool: ToolHandler = {
  name: 'Glob',
  description: definition.function.description,
  category: 'read-only',
  definition,
  execute,
};
