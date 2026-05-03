import { glob as globFn } from 'glob';
import fs from 'fs';
import path from 'path';
import type { ToolDefinition, ToolHandler, ToolResult } from './types.js';

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
    const matches = await globFn(pattern, {
      cwd: searchPath,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**'],
    });

    // Sort by modification time (newest first)
    const withStats = matches.map(file => {
      const fullPath = path.resolve(searchPath, file);
      try {
        const stat = fs.statSync(fullPath);
        return { file, mtime: stat.mtimeMs };
      } catch {
        return { file, mtime: 0 };
      }
    });

    withStats.sort((a, b) => b.mtime - a.mtime);

    const result = withStats.map(f => f.file);

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
