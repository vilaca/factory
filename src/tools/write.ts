import fs from 'fs/promises';
import path from 'path';
import type { ToolContext, ToolDefinition, ToolHandler, ToolResult } from './types.js';
import { assertPathAllowed, PathDenied } from '../security/paths.js';
import { getPathPolicy } from '../security/policy-state.js';

const definition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'Write',
    description: 'Write content to a file. Creates the file if it does not exist, or overwrites it if it does. Creates parent directories as needed.',
    parameters: {
      type: 'object',
      required: ['file_path', 'content'],
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the file to write',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file',
        },
      },
    },
  },
};

async function execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const filePath = args.file_path as string;
  const content = args.content as string;

  if (!filePath) {
    return { success: false, output: 'file_path is required' };
  }
  if (content === undefined || content === null) {
    return { success: false, output: 'content is required' };
  }

  // Resolve relative paths against the per-tab cwd, then enforce the
  // secret-path deny list — see src/tools/read.ts for the rationale.
  const absPath = path.resolve(ctx?.cwd ?? process.cwd(), filePath);
  let resolved: string;
  try {
    resolved = await assertPathAllowed(absPath, getPathPolicy());
  } catch (err) {
    if (err instanceof PathDenied) return { success: false, output: err.message };
    throw err;
  }

  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, 'utf-8');
    const lines = content.split('\n').length;
    return { success: true, output: `Wrote ${lines} lines to ${resolved}` };
  } catch (err: any) {
    return { success: false, output: `Error writing ${resolved}: ${err.message}` };
  }
}

export const writeTool: ToolHandler = {
  name: 'Write',
  description: definition.function.description,
  category: 'write',
  definition,
  execute,
};
