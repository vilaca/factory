import path from 'path';
import { TOOL_NAMES } from '../../tools/types.js';

export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

export function formatArgsBrief(args: Record<string, unknown>, toolName?: string): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    const str = typeof v === 'string' ? v : JSON.stringify(v);
    const oneLine = str.split('\n')[0] ?? '';
    // For bash commands, use a much higher limit (1000 chars) since commands can be long
    const maxLength = toolName === TOOL_NAMES.Bash ? 1000 : 80;
    const truncated = oneLine.length > maxLength ? oneLine.slice(0, maxLength) + '…' : oneLine;
    parts.push(`${k}=${truncated}`);
  }
  return parts.join(' ');
}

export function formatScopedInstructionFiles(files: string[], projectRoot: string): string {
  return files
    .map(file => {
      const rel = path.relative(projectRoot, file);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return file;
      return rel;
    })
    .join(', ');
}
