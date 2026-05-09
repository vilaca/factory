import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ToolContext, ToolDefinition, ToolHandler, ToolResult } from './types.js';
import { TOOL_NAMES } from './types.js';
import { assertPathAllowed, buildDenyMatcher, PathDenied } from '../security/paths.js';
import { errorCode, errorMessage } from '../utils/errors.js';

const execFileAsync = promisify(execFile);

// Cap how much output we'll buffer from rg/grep. 10 MiB is well above any
// useful single-tool-call result (the model can't usefully consume more)
// but small enough that a runaway "search everything" doesn't OOM.
const SEARCH_OUTPUT_MAX_BYTES = 10 * 1024 * 1024;

// Cap on returned match lines after filtering. rg/grep can produce
// thousands of lines on a broad pattern; the model can't usefully consume
// more than a few hundred, and ungated output blows the context window.
// Mirrors Glob's MAX_RESULTS=500 — slightly higher here because Grep with
// include_content returns one line per match, and a tight enough pattern
// can have 1000 legitimate hits worth showing.
const MAX_RESULT_LINES = 1000;

const definition: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAMES.Grep,
    description:
      'Search file contents using regex. Uses ripgrep if available, otherwise falls back to grep. Returns matching file paths or lines with context. Use this instead of grep/rg commands.',
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
          description:
            'If true, show matching lines with line numbers. If false (default), show only file paths.',
        },
      },
    },
  },
};

async function tryRipgrep(
  pattern: string,
  searchPath: string,
  fileGlob: string | undefined,
  includeContent: boolean | undefined,
  signal?: AbortSignal,
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

    const { stdout } = await execFileAsync('rg', args, {
      maxBuffer: SEARCH_OUTPUT_MAX_BYTES,
      signal,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return { success: true, output: 'No matches found.', empty: true };
    return { success: true, output: trimmed };
  } catch (err: unknown) {
    const code = errorCode(err);
    if (code === 'ENOENT') return null; // ripgrep not installed — fall back to grep.
    // execFile sets `code` to the numeric exit code (typed as string at the
    // helper level since Node uses both string and number — ripgrep uses 1
    // for "no matches", which we want to convert to a clean empty result).
    if ((err as { code?: unknown }).code === 1) {
      return { success: true, output: 'No matches found.', empty: true };
    }
    // Ripgrep ran and exited >= 2 (regex error, IO failure, etc.). Surface
    // the failure rather than silently falling back to grep — the same query
    // will usually fail there too, and hiding the real diagnostic makes the
    // model retry blindly.
    const stderr = (err as { stderr?: { toString(): string } }).stderr?.toString().trim();
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty-string stderr should fall through too
    return { success: false, output: `Grep error: ${stderr || errorMessage(err)}` };
  }
}

async function tryGrep(
  pattern: string,
  searchPath: string,
  fileGlob: string | undefined,
  includeContent: boolean | undefined,
  signal?: AbortSignal,
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

    const { stdout } = await execFileAsync('grep', args, {
      maxBuffer: SEARCH_OUTPUT_MAX_BYTES,
      signal,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return { success: true, output: 'No matches found.', empty: true };
    return { success: true, output: trimmed };
  } catch (err: unknown) {
    if ((err as { code?: unknown }).code === 1) {
      return { success: true, output: 'No matches found.', empty: true };
    }
    return { success: false, output: `Grep error: ${errorMessage(err)}` };
  }
}

async function execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const rawPath = (args.path as string) ?? ctx?.cwd ?? process.cwd();
  const fileGlob = args.glob as string | undefined;
  const includeContent = (args.include_content as boolean) ?? false;

  if (!pattern) {
    return { success: false, output: 'pattern is required' };
  }

  // Resolve to absolute against the per-tab cwd, then enforce the deny list
  // on the search root itself (catches `Grep(path=~/.ssh)`). Output paths
  // are absolute because we hand rg/grep an absolute search root, which
  // also makes the post-filter check below straightforward.
  const absSearchPath = path.resolve(ctx?.cwd ?? process.cwd(), rawPath);
  const policy = ctx?.pathPolicy ?? {};
  let searchPath: string;
  try {
    searchPath = await assertPathAllowed(absSearchPath, policy);
  } catch (err) {
    if (err instanceof PathDenied) return { success: false, output: err.message };
    throw err;
  }

  const rgResult = await tryRipgrep(pattern, searchPath, fileGlob, includeContent, ctx?.signal);
  const result =
    rgResult ?? (await tryGrep(pattern, searchPath, fileGlob, includeContent, ctx?.signal));

  // Post-filter: a search rooted at e.g. ~/ would otherwise let rg/grep
  // recurse into ~/.ssh and surface filenames (with -l) or content lines
  // (with -n). assertPathAllowed only guards the root; the deny list has
  // to be applied to each result path too.
  const isDenied = await buildDenyMatcher(policy);
  return filterDeniedResults(result, includeContent, isDenied);
}

function filterDeniedResults(
  result: ToolResult,
  includeContent: boolean,
  isDenied: (candidate: string) => string | null,
): ToolResult {
  if (!result.success || result.empty || !result.output) return result;
  const lines = result.output.split('\n');
  const kept: string[] = [];
  let suppressed = 0;
  let truncated = 0;
  for (const line of lines) {
    // -l: each line is a path. -n: `path:lineno:content` — split on the
    // first ':' for the path component. File paths containing ':' are an
    // accepted edge case (rare on macOS/Linux); the colon-split would
    // misparse and we'd over-keep, never under-keep, which is the safe
    // direction here.
    const pathPart = includeContent ? line.split(':', 1)[0] : line;
    if (pathPart && isDenied(pathPart)) {
      suppressed++;
      continue;
    }
    if (kept.length >= MAX_RESULT_LINES) {
      truncated++;
      continue;
    }
    kept.push(line);
  }
  const footers: string[] = [];
  if (suppressed > 0) {
    footers.push(
      `[${suppressed} match${suppressed === 1 ? '' : 'es'} suppressed: under deny-listed path]`,
    );
  }
  if (truncated > 0) {
    footers.push(
      `[+${truncated} more match${truncated === 1 ? '' : 'es'} truncated — narrow the pattern or path]`,
    );
  }
  if (footers.length === 0) return result;
  if (kept.length === 0) {
    return { success: true, output: `No matches found. ${footers.join(' ')}`, empty: true };
  }
  return { ...result, output: `${kept.join('\n')}\n${footers.join('\n')}` };
}

export const grepTool: ToolHandler = {
  name: TOOL_NAMES.Grep,
  description: definition.function.description,
  category: 'read-only',
  definition,
  execute,
};
