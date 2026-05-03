import { spawn } from 'child_process';
import type { ToolDefinition, ToolHandler, ToolResult } from './types.js';

const definition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'Bash',
    description: 'Execute a shell command and return its output (stdout + stderr). Use for system commands, git, builds, tests, and other terminal operations.',
    parameters: {
      type: 'object',
      required: ['command'],
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds. Default: 120000 (2 minutes).',
        },
      },
    },
  },
};

async function execute(args: Record<string, unknown>): Promise<ToolResult> {
  const command = args.command as string;
  const timeout = (args.timeout as number) ?? 120000;

  if (!command) {
    return { success: false, output: 'command is required' };
  }

  return new Promise((resolve) => {
    const proc = spawn('sh', ['-c', command], {
      cwd: process.cwd(),
      env: process.env,
      timeout,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      const combined = [stdout, stderr].filter(Boolean).join('\n');
      const truncated = combined.length > 50000
        ? combined.slice(0, 50000) + '\n...(output truncated)'
        : combined;

      let output: string;
      if (code === 0) {
        output = truncated || '(no output)';
      } else {
        output = truncated
          ? `(exit code ${code})\n${truncated}`
          : `(exit code ${code})`;
      }

      // The command ran — even a non-zero exit is informational (lint errors,
      // failing tests, grep miss). Don't treat as a tool failure; let the
      // model interpret the exit code in the output. Real tool failures only
      // come from the 'error' event below (spawn / system error).
      resolve({ success: true, output });
    });

    proc.on('error', (err) => {
      resolve({ success: false, output: `Failed to execute: ${err.message}` });
    });
  });
}

export const bashTool: ToolHandler = {
  name: 'Bash',
  description: definition.function.description,
  category: 'execute',
  definition,
  execute,
};
