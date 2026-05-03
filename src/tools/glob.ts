import fs from 'fs';
import { glob as fsGlob } from 'fs/promises';
import path from 'path';
import type { ToolDefinition, ToolHandler, ToolResult } from './types.js';

const EXCLUDE_DIR_SEGMENTS = new Set(['node_modules', '.git']);

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

async function execute(args: Record<string, unknown>): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const searchPath = (args.path as string) ?? process.cwd();

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
        const stat = fs.statSync(fullPath);
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

    const truncated = result.length > 500
      ? [...result.slice(0, 500), `\n... (${result.length - 500} more files)`]
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
