import fs from 'fs/promises';
import path from 'path';
import type { ToolDefinition, ToolHandler, ToolResult } from './types.js';

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

async function execute(args: Record<string, unknown>): Promise<ToolResult> {
  const filePath = args.file_path as string;
  const content = args.content as string;

  if (!filePath) {
    return { success: false, output: 'file_path is required' };
  }
  if (content === undefined || content === null) {
    return { success: false, output: 'content is required' };
  }

  const resolved = path.resolve(filePath);

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
