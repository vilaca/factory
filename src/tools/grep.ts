import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ToolContext, ToolDefinition, ToolHandler, ToolResult } from './types.js';

const execFileAsync = promisify(execFile);

// Cap how much output we'll buffer from rg/grep. 10 MiB is well above any
// useful single-tool-call result (the model can't usefully consume more)
// but small enough that a runaway "search everything" doesn't OOM.
const SEARCH_OUTPUT_MAX_BYTES = 10 * 1024 * 1024;

const definition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'Grep',
    description: 'Search file contents using regex. Uses ripgrep if available, otherwise falls back to grep. Returns matching file paths or lines with context. Use this instead of grep/rg commands.',
    parameters: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex pattern to search for',
        },
        path: {
          type: 'string',
          description: 'File or directory to search in. Defaults to current working directory.',
        },
        glob: {
          type: 'string',
          description: 'Glob pattern to filter files (e.g. "*.ts", "*.{js,jsx}")',
        },
        include_content: {
          type: 'boolean',
          description: 'If true, show matching lines with line numbers. If false (default), show only file paths.',
        },
      },
    },
  },
};

async function tryRipgrep(
  pattern: string,
  searchPath: string,
  fileGlob?: string,
  includeContent?: boolean,
): Promise<ToolResult | null> {
  try {
    const args: string[] = ['--no-heading', '--color=never'];

    if (includeContent) {
      args.push('-n'); // line numbers
    } else {
      args.push('-l'); // files only
    }

    if (fileGlob) {
      args.push('--glob', fileGlob);
    }

    args.push('--glob', '!node_modules', '--glob', '!.git');
    args.push(pattern, searchPath);

    const { stdout } = await execFileAsync('rg', args, { maxBuffer: SEARCH_OUTPUT_MAX_BYTES });
    const trimmed = stdout.trim();
    if (!trimmed) return { success: true, output: 'No matches found.', empty: true };
    return { success: true, output: trimmed };
  } catch (err: any) {
    if (err.code === 'ENOENT') return null; // ripgrep not installed — fall back to grep.
    if (err.code === 1) return { success: true, output: 'No matches found.', empty: true };
    // Ripgrep ran and exited >= 2 (regex error, IO failure, etc.). Surface
    // the failure rather than silently falling back to grep — the same query
    // will usually fail there too, and hiding the real diagnostic makes the
    // model retry blindly.
    return { success: false, output: `Grep error: ${err.stderr?.toString().trim() || err.message}` };
  }
}

async function tryGrep(
  pattern: string,
  searchPath: string,
  fileGlob?: string,
  includeContent?: boolean,
): Promise<ToolResult> {
  try {
    const args: string[] = ['-r', '--color=never'];

    if (includeContent) {
      args.push('-n');
    } else {
      args.push('-l');
    }

    if (fileGlob) {
      args.push('--include', fileGlob);
    }

    args.push('--exclude-dir=node_modules', '--exclude-dir=.git');
    args.push('-E', pattern, searchPath);

    const { stdout } = await execFileAsync('grep', args, { maxBuffer: SEARCH_OUTPUT_MAX_BYTES });
    const trimmed = stdout.trim();
    if (!trimmed) return { success: true, output: 'No matches found.', empty: true };
    return { success: true, output: trimmed };
  } catch (err: any) {
    if (err.code === 1) return { success: true, output: 'No matches found.', empty: true };
    return { success: false, output: `Grep error: ${err.message}` };
  }
}

async function execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const searchPath = (args.path as string) ?? ctx?.cwd ?? process.cwd();
  const fileGlob = args.glob as string | undefined;
  const includeContent = (args.include_content as boolean) ?? false;

  if (!pattern) {
    return { success: false, output: 'pattern is required' };
  }

  // Try ripgrep first, fall back to grep
  const rgResult = await tryRipgrep(pattern, searchPath, fileGlob, includeContent);
  if (rgResult) return rgResult;

  return tryGrep(pattern, searchPath, fileGlob, includeContent);
}

export const grepTool: ToolHandler = {
  name: 'Grep',
  description: definition.function.description,
  category: 'read-only',
  definition,
  execute,
};
