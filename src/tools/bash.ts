import { spawn } from 'child_process';
import type { ToolContext, ToolDefinition, ToolHandler, ToolResult } from './types.js';

// Marker that the wrapped command emits on stdout so we can extract the
// post-run $PWD without polluting the user-visible output. Random-ish prefix
// to avoid colliding with anything a real command might emit.
const CWD_SENTINEL = '__FACTORY_CWD_AFTER__';

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

async function execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
  const command = args.command as string;
  const timeout = (args.timeout as number) ?? 120000;
  const cwd = ctx?.cwd ?? process.cwd();

  if (!command) {
    return { success: false, output: 'command is required' };
  }

  // Wrap the user command so we can capture the final $PWD without disturbing
  // the exit code. The user's command must run in the SAME shell as the
  // printf below — otherwise `cd /foo` in a subshell wouldn't be visible to
  // `$PWD`. We use a leading newline before the bookkeeping so commands that
  // don't end in a newline (or that emit incomplete lines) still get a clean
  // separator. Variable names use a `__factory_` prefix to avoid colliding
  // with anything the user's command might set.
  const wrapped = `${command}\n__factory_rc=$?\nprintf '\\n%s%s\\n' '${CWD_SENTINEL}:' "$PWD"\nexit $__factory_rc`;

  return new Promise((resolve) => {
    const proc = spawn('sh', ['-c', wrapped], {
      cwd,
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

    // TODO: split stdout and stderr in the output instead of concatenating.
    // Motivation:
    //   - Models confuse warnings/progress on stderr (npm, cargo, pytest)
    //     with real errors and chase phantom failures.
    //   - Conversely, when a command fails with a useful message on stderr,
    //     it gets mixed into stdout noise and buried.
    //   - Tools that write structured data to stdout (jq, git diff) become
    //     unparseable when stderr lines are interleaved.
    // Shape: keep the combined view for short outputs; for non-empty stderr,
    // emit a fenced "--- stderr ---" section after stdout so the model can
    // see them separately without doubling the token cost on the common
    // case where stderr is empty.
    proc.on('close', (code) => {
      // Strip the sentinel from stdout before showing the user/model. Look at
      // the very tail (\\n SENTINEL : path \\n?) to avoid eating earlier text
      // that might coincidentally contain the sentinel string.
      let cwdAfter: string | undefined;
      const sentinelRe = new RegExp(`\\n${CWD_SENTINEL}:([^\\n]*)\\n?$`);
      const m = stdout.match(sentinelRe);
      if (m) {
        cwdAfter = m[1];
        stdout = stdout.replace(sentinelRe, '');
      }

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
      // Only surface cwdAfter when the command actually changed the dir —
      // otherwise the agent loop wastefully re-renders refreshGitState etc.
      const dirChanged = cwdAfter !== undefined && cwdAfter !== cwd;
      resolve({ success: true, output, cwdAfter: dirChanged ? cwdAfter : undefined });
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
