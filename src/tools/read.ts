import fs from 'fs/promises';
import path from 'path';
import type { ToolDefinition, ToolHandler, ToolResult } from './types.js';

const definition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'Read',
    description: 'Read a file from the filesystem. Returns content with line numbers. Use this instead of cat/head/tail.',
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

async function execute(args: Record<string, unknown>): Promise<ToolResult> {
  const filePath = args.file_path as string;
  const offset = (args.offset as number) ?? 0;
  const limit = args.limit as number | undefined;

  if (!filePath) {
    return { success: false, output: 'file_path is required' };
  }

  const resolved = path.resolve(filePath);

  try {
    const content = await fs.readFile(resolved, 'utf-8');
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
  } catch (err: any) {
    return { success: false, output: `Error reading ${resolved}: ${err.message}` };
  }
}

export const readTool: ToolHandler = {
  name: 'Read',
  description: definition.function.description,
  category: 'read-only',
  definition,
  execute,
};
