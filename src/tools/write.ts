import fs from 'fs/promises';
import path from 'path';
import type { ToolContext, ToolDefinition, ToolHandler, ToolResult } from './types.js';
import { TOOL_NAMES } from './types.js';
import { assertPathAllowed, PathDenied } from '../security/paths.js';
import { errorMessage } from '../utils/errors.js';

const definition: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAMES.Write,
    description:
      'Write content to a file. Creates the file if it does not exist, or overwrites it if it does. Creates parent directories as needed.',
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
  const content = args.content;

  if (!filePath) {
    return { success: false, output: 'file_path is required' };
  }
  if (content === undefined || content === null) {
    return { success: false, output: 'content is required' };
  }
  // fs.writeFile coerces non-string values silently (a number gets stringified
  // via String(value), an object via JSON-ish toString). That's almost never
  // what the model meant — usually it's a model-error like passing the parsed
  // content object instead of its serialized form. Reject with a clear message
  // so the model fixes the call.
  if (typeof content !== 'string') {
    return {
      success: false,
      output: `content must be a string (got ${typeof content}). If you meant to write JSON or another serialized form, stringify it first.`,
    };
  }

  // Resolve relative paths against the per-tab cwd, then enforce the
  // secret-path deny list — see src/tools/read.ts for the rationale.
  const absPath = path.resolve(ctx?.cwd ?? process.cwd(), filePath);
  let resolved: string;
  try {
    resolved = await assertPathAllowed(absPath, ctx?.pathPolicy);
  } catch (err) {
    if (err instanceof PathDenied) return { success: false, output: err.message };
    throw err;
  }

  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, { encoding: 'utf-8', signal: ctx?.signal });
    const lines = content.split('\n').length;
    return { success: true, output: `Wrote ${lines} lines to ${resolved}` };
  } catch (err: unknown) {
    return { success: false, output: `Error writing ${resolved}: ${errorMessage(err)}` };
  }
}

export const writeTool: ToolHandler = {
  name: TOOL_NAMES.Write,
  description: definition.function.description,
  category: 'write',
  definition,
  execute,
};
