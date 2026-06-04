import fs from 'fs';
import path from 'path';
import { factoryHomePath } from '../../../utils/factory-paths.js';

export interface SessionLogFile {
  name: string;
  path: string;
  mtime: Date;
}

export function sessionsDir(): string {
  return factoryHomePath('sessions');
}

export async function listSessionLogs(): Promise<SessionLogFile[]> {
  const dir = sessionsDir();
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const records = await Promise.all(
    entries
      .filter(f => f.endsWith('.jsonl'))
      .map(async name => {
        const fullPath = path.join(dir, name);
        try {
          const stat = await fs.promises.stat(fullPath);
          return { name, path: fullPath, mtime: stat.mtime };
        } catch {
          return null;
        }
      }),
  );
  return records
    .filter((r): r is SessionLogFile => r !== null)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

export async function extractUserInputs(filePath: string): Promise<string[]> {
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  const inputs: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry.type === 'user-input' && typeof entry.content === 'string') {
        inputs.push(entry.content);
      }
    } catch {
      // skip malformed lines
    }
  }
  return inputs;
}

export async function readSessionLines(filePath: string): Promise<string[]> {
  const raw = await fs.promises.readFile(filePath, 'utf-8');
  return raw.split('\n').filter(Boolean);
}
