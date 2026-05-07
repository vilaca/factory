import { glob as fsGlob } from 'fs/promises';
import path from 'path';
import type { ToolContext, ToolDefinition, ToolHandler, ToolResult } from './types.js';
import { TOOL_NAMES } from './types.js';
import { assertPathAllowed, buildDenyMatcher, PathDenied } from '../security/paths.js';
import { errorMessage } from '../utils/errors.js';

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
    name: TOOL_NAMES.Glob,
    description: 'Find files matching a glob pattern (e.g. "**/*.ts", "src/**/*.js"). Returns file paths in glob iteration order. Use this instead of find or ls.',
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
  const rawPath = (args.path as string) ?? ctx?.cwd ?? process.cwd();

  if (!pattern) {
    return { success: false, output: 'pattern is required' };
  }

  // Enforce the deny list on the search root (catches `Glob(path=~/.ssh)`),
  // then again on each match below so a wider-rooted glob can't surface
  // filenames from a denied subtree (`pattern=**/*, path=~`). Symlink
  // defense rides on assertPathAllowed's realpath; the per-match check is
  // lexical because Node's fs.glob doesn't follow symlinks during recursion.
  const absSearchPath = path.resolve(ctx?.cwd ?? process.cwd(), rawPath);
  const policy = ctx?.pathPolicy ?? {};
  let searchPath: string;
  try {
    searchPath = await assertPathAllowed(absSearchPath, policy);
  } catch (err) {
    if (err instanceof PathDenied) return { success: false, output: err.message };
    throw err;
  }

  const isDenied = await buildDenyMatcher(policy);
  try {
    // `withFileTypes: true` yields Dirent objects, so we can filter to files
    // without an fs.stat() per match — that O(n) syscall storm was the main
    // cost on large repos, especially since we then truncate to MAX_RESULTS.
    // The previous implementation also sorted by mtime, but the sort had to
    // run before truncation to be meaningful, which forced the stat storm.
    // Drop the mtime sort: glob iteration order is good enough, and callers
    // who need recency can run `ls -t` via Bash.
    const matches: string[] = [];
    let suppressed = 0;
    for await (const dirent of fsGlob(pattern, {
      cwd: searchPath,
      withFileTypes: true,
      exclude: (entry) => {
        const name = typeof entry === 'string' ? entry : entry.name;
        return name.split(path.sep).some(seg => EXCLUDE_DIR_SEGMENTS.has(seg));
      },
    })) {
      // fs.glob has no native AbortSignal hook, so check between matches.
      // On a multi-second walk over a large repo this catches Ctrl-C early
      // instead of waiting for the iterator to finish.
      if (ctx?.signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      if (typeof dirent === 'string') continue; // belt-and-braces; withFileTypes should always yield Dirent
      if (!dirent.isFile()) continue;
      const fullPath = path.join(dirent.parentPath, dirent.name);
      if (isDenied(fullPath)) {
        suppressed++;
        continue;
      }
      // Emit absolute paths so Glob output drops straight into Read/Edit/
      // Write without the model having to prepend the search root. Models
      // sometimes get that prepend wrong (skipping the cwd or doubling a
      // segment); fully-qualified paths sidestep the class.
      matches.push(fullPath);
    }

    const suppressedNote = suppressed > 0
      ? `\n[${suppressed} suppressed: under deny-listed path]`
      : '';

    if (matches.length === 0) {
      return {
        success: true,
        output: `No files matched the pattern.${suppressedNote}`,
        empty: suppressed === 0,
      };
    }

    const truncated = matches.length > MAX_RESULTS
      ? [...matches.slice(0, MAX_RESULTS), `\n... (${matches.length - MAX_RESULTS} more files)`]
      : matches;

    return { success: true, output: truncated.join('\n') + suppressedNote };
  } catch (err: unknown) {
    return { success: false, output: `Glob error: ${errorMessage(err)}` };
  }
}

export const globTool: ToolHandler = {
  name: TOOL_NAMES.Glob,
  description: definition.function.description,
  category: 'read-only',
  definition,
  execute,
};
