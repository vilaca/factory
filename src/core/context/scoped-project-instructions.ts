import os from 'os';
import path from 'path';
import { loadScopedProjectInstructions } from '../config/index.js';

export interface ScopedProjectInstructionsState {
  projectRoot: string;
  touchedDirs: Set<string>;
  scopedInstructions: string | null;
  loadedFiles: Set<string>;
  virtualRootDirs: string[];
}

export function createScopedProjectInstructionsState(
  projectRoot: string,
  virtualRootDirs: string[] = [path.join(os.homedir(), '.factory')],
): ScopedProjectInstructionsState {
  const resolvedRoot = path.resolve(projectRoot);
  return {
    projectRoot: resolvedRoot,
    touchedDirs: new Set<string>([resolvedRoot]),
    scopedInstructions: null,
    loadedFiles: new Set<string>(),
    virtualRootDirs,
  };
}

function isWithinRoot(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function extractPathsFromCommand(command: string, cwd: string): string[] {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const paths: string[] = [];
  for (const rawToken of tokens) {
    let token = rawToken.trim();
    if (!token || token.startsWith('-')) continue;
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      token = token.slice(1, -1);
    }
    if (!token.includes('/') && !token.startsWith('.')) continue;
    if (token.startsWith('~')) {
      token = path.join(os.homedir(), token.slice(1));
    }
    const abs = path.resolve(cwd, token);
    paths.push(abs);
  }
  return paths;
}

function toProbeDirs(_toolName: string, args: Record<string, unknown>, cwd: string): string[] {
  const resolvedCwd = path.resolve(cwd);
  const rawFilePath = typeof args.file_path === 'string' ? args.file_path : undefined;
  const rawSearchPath = typeof args.path === 'string' ? args.path : undefined;
  const rawCommand = typeof args.command === 'string' ? args.command : undefined;

  // Any successful tool call counts as "touching" the current working
  // directory. This ensures scoped instructions can load/update even for
  // tools like Bash that don't carry explicit path fields.
  const dirs = new Set<string>([resolvedCwd]);

  if (rawFilePath) {
    const abs = path.resolve(resolvedCwd, rawFilePath);
    dirs.add(path.dirname(abs));
  }

  if (rawSearchPath) {
    const abs = path.resolve(resolvedCwd, rawSearchPath);
    dirs.add(abs);
    dirs.add(path.dirname(abs));
  }

  if (rawCommand) {
    for (const absPath of extractPathsFromCommand(rawCommand, resolvedCwd)) {
      dirs.add(path.dirname(absPath));
    }
  }

  return Array.from(dirs);
}

export async function refreshScopedProjectInstructionsFromToolCall(
  state: ScopedProjectInstructionsState,
  event: { toolName: string; args: Record<string, unknown> },
  cwd: string,
): Promise<{ changed: boolean; newFiles: string[] }> {
  const probeDirs = toProbeDirs(event.toolName, event.args, cwd);
  let hasInRootProbe = false;
  for (const dir of probeDirs) {
    const abs = path.resolve(dir);
    if (!isWithinRoot(abs, state.projectRoot)) continue;
    hasInRootProbe = true;
    if (!state.touchedDirs.has(abs)) {
      state.touchedDirs.add(abs);
    }
  }

  if (!hasInRootProbe) return { changed: false, newFiles: [] };

  const loadedFiles: Set<string> = new Set();
  const scoped = await loadScopedProjectInstructions(
    state.projectRoot,
    state.touchedDirs,
    filePath => {
      loadedFiles.add(filePath);
    },
    { virtualRootDirs: state.virtualRootDirs },
  );

  const newFiles = Array.from(loadedFiles).filter(f => !state.loadedFiles.has(f));
  const changed = scoped !== state.scopedInstructions;
  state.scopedInstructions = scoped;
  state.loadedFiles = loadedFiles;

  return { changed, newFiles };
}
