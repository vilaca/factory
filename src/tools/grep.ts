import path from 'path';
import { spawn } from 'child_process';
import type { ToolContext, ToolDefinition, ToolHandler, ToolResult } from './types.js';
import { TOOL_NAMES } from './types.js';
import { assertPathAllowed, buildDenyMatcher, PathDenied } from '../security/paths.js';
import { errorCode, errorMessage } from '../utils/errors.js';

// Cap on returned match lines after filtering. rg/grep can produce
// thousands of lines on a broad pattern; the model can't usefully consume
// more than a few hundred, and ungated output blows the context window.
// Mirrors Glob's MAX_RESULTS=500 — slightly higher here because Grep with
// include_content returns one line per match, and a tight enough pattern
// can have 1000 legitimate hits worth showing.
const MAX_RESULT_LINES = 1000;

// Streaming slack: kill the search once we cross the line cap by this much.
// Slack absorbs a partial last line and gives filterDeniedResults enough
// surplus to exhaust suppressed (deny-listed) matches before truncating.
const STREAM_LINE_SLACK = 50;

// Cap on stderr we'll keep around for diagnostics. rg/grep typically write
// a few bytes; this guards against a runaway error spew under abort/SIGTERM.
const STDERR_CAPTURE_BYTES = 64 * 1024;

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

interface StreamResult {
  stdout: string;
  stderr: string;
  /** Process exit code, or null if killed by signal. */
  exitCode: number | null;
  /** True when we killed the child after crossing the line cap. */
  truncated: boolean;
}

/**
 * Spawn `cmd` and stream stdout, killing the child after we cross
 * `MAX_RESULT_LINES + STREAM_LINE_SLACK` newlines so a runaway "search
 * everything" can't blow the buffer or the agent's memory. stderr is
 * captured up to STDERR_CAPTURE_BYTES for diagnostics.
 *
 * Rejects with the underlying error on spawn failure (so callers can
 * detect ENOENT and fall back to a different binary). On clean exit (or
 * a self-triggered SIGTERM), resolves with the partial buffer.
 */
async function streamSearch(
  cmd: string,
  args: string[],
  signal: AbortSignal | undefined,
  lineLimit: number,
): Promise<StreamResult> {
  return new Promise<StreamResult>((resolve, reject) => {
    const opts: { signal?: AbortSignal } = {};
    if (signal) opts.signal = signal;
    const child = spawn(cmd, args, opts);

    let stdout = '';
    let stderr = '';
    let newlineCount = 0;
    let killedByLimit = false;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      // Walk the chunk once counting newlines. Once we cross the cap,
      // SIGTERM the child — we already have enough output for the model
      // and any further bytes are wasted memory.
      for (let i = 0; i < chunk.length; i++) {
        if (chunk.charCodeAt(i) === 10) {
          newlineCount++;
          if (newlineCount > lineLimit + STREAM_LINE_SLACK && !killedByLimit) {
            killedByLimit = true;
            child.kill('SIGTERM');
            break;
          }
        }
      }
    });

    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < STDERR_CAPTURE_BYTES) {
        stderr += chunk;
      }
    });

    child.once('error', err => settle(() => reject(err)));
    child.once('close', code => {
      // killedByLimit means we triggered SIGTERM; treat as success.
      if (killedByLimit) {
        // Trim to the last full line so callers see clean line-oriented output.
        const lastNl = stdout.lastIndexOf('\n');
        const cleaned = lastNl >= 0 ? stdout.slice(0, lastNl + 1) : stdout;
        settle(() => resolve({ stdout: cleaned, stderr, exitCode: 0, truncated: true }));
        return;
      }
      settle(() => resolve({ stdout, stderr, exitCode: code, truncated: false }));
    });
  });
}

async function tryRipgrep(
  pattern: string,
  searchPath: string,
  fileGlob: string | undefined,
  includeContent: boolean | undefined,
  signal?: AbortSignal,
): Promise<ToolResult | null> {
  const args: string[] = ['--no-heading', '--color=never'];

  if (includeContent) {
    args.push('-n'); // line numbers
  } else {
    args.push('-l'); // files only
  }

  if (fileGlob) {
    args.push('--glob', fileGlob);
  }

  // Skip vendor and build/coverage trees by default. These produce huge
  // duplicate matches (compiled output, c8 HTML reports embed source
  // snippets) the model can't usefully consume.
  for (const ex of [
    '!node_modules',
    '!.git',
    '!dist',
    '!dist-test',
    '!coverage',
    '!*.tsbuildinfo',
  ]) {
    args.push('--glob', ex);
  }
  args.push(pattern, searchPath);

  let result: StreamResult;
  try {
    result = await streamSearch('rg', args, signal, MAX_RESULT_LINES);
  } catch (err: unknown) {
    if (signal?.aborted) throw err;
    if (errorCode(err) === 'ENOENT') return null; // ripgrep not installed — fall back to grep.
    return { success: false, output: `Grep error: ${errorMessage(err)}` };
  }

  // rg conventions: exit 0 + content = matches; exit 1 + empty = no
  // matches; exit >= 2 = regex/IO error. SIGTERM via our line cap leaves
  // exitCode === 0 with truncated === true.
  if (result.exitCode === 0 || result.truncated) {
    const trimmed = result.stdout.trim();
    if (!trimmed) return { success: true, output: 'No matches found.', empty: true };
    return { success: true, output: trimmed };
  }
  if (result.exitCode === 1) {
    return { success: true, output: 'No matches found.', empty: true };
  }
  // Surface rg's own diagnostic rather than silently falling back to
  // plain grep — the same query usually fails there too, and hiding the
  // real error makes the model retry blindly.
  const stderr = result.stderr.trim();
  return {
    success: false,
    output: `Grep error: ${stderr.length > 0 ? stderr : `rg exited ${result.exitCode}`}`,
  };
}

async function tryGrep(
  pattern: string,
  searchPath: string,
  fileGlob: string | undefined,
  includeContent: boolean | undefined,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const args: string[] = ['-r', '--color=never'];

  if (includeContent) {
    args.push('-n');
  } else {
    args.push('-l');
  }

  if (fileGlob) {
    args.push('--include', fileGlob);
  }

  for (const dir of ['node_modules', '.git', 'dist', 'dist-test', 'coverage']) {
    args.push(`--exclude-dir=${dir}`);
  }
  args.push('--exclude=*.tsbuildinfo');
  args.push('-E', pattern, searchPath);

  let result: StreamResult;
  try {
    result = await streamSearch('grep', args, signal, MAX_RESULT_LINES);
  } catch (err: unknown) {
    if (signal?.aborted) throw err;
    return { success: false, output: `Grep error: ${errorMessage(err)}` };
  }

  if (result.exitCode === 0 || result.truncated) {
    const trimmed = result.stdout.trim();
    if (!trimmed) return { success: true, output: 'No matches found.', empty: true };
    return { success: true, output: trimmed };
  }
  if (result.exitCode === 1) {
    return { success: true, output: 'No matches found.', empty: true };
  }
  const stderr = result.stderr.trim();
  return {
    success: false,
    output: `Grep error: ${stderr.length > 0 ? stderr : `grep exited ${result.exitCode}`}`,
  };
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
