import fs from 'fs/promises';
import path from 'path';
import type { ToolContext, ToolDefinition, ToolHandler, ToolResult } from './types.js';
import { TOOL_NAMES } from './types.js';
import { assertPathAllowed, PathDenied } from '../security/paths.js';
import { errorMessage } from '../utils/errors.js';

const definition: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAMES.Read,
    description: 'Read a file (returns content with line numbers, use instead of cat/head/tail) or a directory (returns a sorted listing of its entries, with a trailing "/" on subdirectories).',
    parameters: {
      type: 'object',
      required: ['file_path'],
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the file to read',
        },
        offset: {
          type: 'number',
          description: 'Line number to start reading from (0-based). Optional.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to read. Optional, defaults to 2000.',
        },
      },
    },
  },
};

// Lines shown in the terminal preview. The full content always goes to the
// model via `output`; this only controls the chat-pane snippet.
const DISPLAY_PREVIEW_LINES = 5;

function formatNumberedLine(lineNum: number, line: string, padWidth: number): string {
  return `${lineNum.toString().padStart(padWidth)} │ ${line}`;
}

async function execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const filePath = args.file_path as string;
  const offset = (args.offset as number) ?? 0;
  const limit = args.limit as number | undefined;

  if (!filePath) {
    return { success: false, output: 'file_path is required' };
  }

  // Resolve relative paths against the per-tab cwd first; assertPathAllowed
  // then enforces the secret-path deny list (~/.ssh, ~/.aws, ~/.factory,
  // /etc/shadow, etc.) — see src/security/paths.ts. The remaining gap
  // (positive jail to allowed roots, applied uniformly across Glob/Grep)
  // is tracked separately.
  const absPath = path.resolve(ctx?.cwd ?? process.cwd(), filePath);
  let resolved: string;
  try {
    resolved = await assertPathAllowed(absPath, ctx?.pathPolicy);
  } catch (err) {
    if (err instanceof PathDenied) return { success: false, output: err.message };
    throw err;
  }

  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const names = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      const output = names.length === 0
        ? `${resolved} is an empty directory.`
        : `${resolved}:\n${names.join('\n')}`;
      const previewSize = Math.min(names.length, DISPLAY_PREVIEW_LINES);
      const previewLines = names.slice(0, previewSize);
      const hidden = names.length - previewSize;
      if (hidden > 0) {
        previewLines.push(`… (+${hidden} entr${hidden === 1 ? 'y' : 'ies'}, full listing sent to model)`);
      }
      const displayOutput = names.length === 0 ? '(empty directory)' : previewLines.join('\n');
      return { success: true, output, displayOutput };
    }
  } catch {
    // Fall through — let the readFile call below produce the canonical
    // ENOENT/EACCES error so we don't double-stat in the success path.
  }

  try {
    const content = await fs.readFile(resolved, { encoding: 'utf-8', signal: ctx?.signal });
    const lines = content.split('\n');
    const end = limit !== undefined ? offset + limit : lines.length;
    const sliced = lines.slice(offset, end);

    // The model gets the same line-number format Claude Code uses: 6-pad + tab.
    const numbered = sliced.map((line, i) => {
      const lineNum = (offset + i + 1).toString().padStart(6);
      return `${lineNum}\t${line}`;
    }).join('\n');

    const total = lines.length;
    let output = numbered;
    if (end < total) {
      output += `\n\n... (${total - end} more lines)`;
    }

    // Terminal preview uses a tighter format: dynamic-width pad + box-drawing
    // separator. Tabs render with variable width in the chat pane and look
    // jagged.
    const padWidth = String(offset + sliced.length).length;
    const previewSize = Math.min(sliced.length, DISPLAY_PREVIEW_LINES);
    const previewLines = sliced.slice(0, previewSize).map((line, i) =>
      formatNumberedLine(offset + i + 1, line, padWidth),
    );
    const hidden = sliced.length - previewSize;
    if (hidden > 0) {
      previewLines.push(`… (+${hidden} line${hidden === 1 ? '' : 's'}, full content sent to model)`);
    }
    const displayOutput = previewLines.join('\n');

    return { success: true, output, displayOutput };
  } catch (err: unknown) {
    return { success: false, output: `Error reading ${resolved}: ${errorMessage(err)}` };
  }
}

// TODO(security): positive path jail.
// The path-policy module hard-denies known secret paths but does not
// constrain reads to a project root. To harden for untrusted models:
//   1. Configurable allowed-roots list (cwd by default).
//   2. Resolve via fs.realpath() to collapse symlinks, then verify the
//      result startsWith() one of the allowed roots + path.sep.
//   3. Reject paths containing '..' segments before resolution as a
//      cheap pre-check (defense in depth, not a substitute for #2).
//   4. Apply uniformly across Read/Write/Edit/Glob/Grep — partial
//      coverage is worse than none because it implies safety.
// Detection (in addition to enforcement): log resolved paths outside
// the allowed roots even when permitted, so traversal attempts are
// visible in the session log.

export const readTool: ToolHandler = {
  name: TOOL_NAMES.Read,
  description: definition.function.description,
  category: 'read-only',
  definition,
  execute,
};
