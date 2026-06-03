import path from 'path';
import { loadScopedProjectInstructions } from '../config/index.js';

export interface ScopedProjectInstructionsState {
  projectRoot: string;
  touchedDirs: Set<string>;
  scopedInstructions: string | null;
  loadedFiles: Set<string>;
}

export function createScopedProjectInstructionsState(
  projectRoot: string,
): ScopedProjectInstructionsState {
  return {
    projectRoot: path.resolve(projectRoot),
    touchedDirs: new Set<string>(),
    scopedInstructions: null,
    loadedFiles: new Set<string>(),
  };
}

function isWithinRoot(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function toProbeDirs(_toolName: string, args: Record<string, unknown>, cwd: string): string[] {
  const resolvedCwd = path.resolve(cwd);
  const rawFilePath = typeof args.file_path === 'string' ? args.file_path : undefined;
  const rawSearchPath = typeof args.path === 'string' ? args.path : undefined;

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

  return Array.from(dirs);
}

export async function refreshScopedProjectInstructionsFromToolCall(
  state: ScopedProjectInstructionsState,
  event: { toolName: string; args: Record<string, unknown>; result: { success: boolean } },
  cwd: string,
): Promise<{ changed: boolean; newFiles: string[] }> {
  if (!event.result.success) return { changed: false, newFiles: [] };

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
  );

  const newFiles = Array.from(loadedFiles).filter(f => !state.loadedFiles.has(f));
  const changed = scoped !== state.scopedInstructions;
  state.scopedInstructions = scoped;
  state.loadedFiles = loadedFiles;

  return { changed, newFiles };
}
