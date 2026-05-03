import fs from 'fs/promises';
import path from 'path';

export async function extractProjectFacts(cwd: string): Promise<string | null> {
  const sections: string[] = [];

  const pkgFacts = await readPackageJson(cwd);
  if (pkgFacts) sections.push(pkgFacts);

  const tscFacts = await readTsConfig(cwd);
  if (tscFacts) sections.push(tscFacts);

  const pyFacts = await readPythonMarkers(cwd);
  if (pyFacts) sections.push(pyFacts);

  if (sections.length === 0) return null;
  return sections.join('\n\n');
}

async function readPackageJson(cwd: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(cwd, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw);
    const lines: string[] = [];
    if (pkg.name) lines.push(`- name: ${pkg.name}${pkg.version ? `@${pkg.version}` : ''}`);
    if (pkg.engines?.node) lines.push(`- Node version required: ${pkg.engines.node}`);
    if (pkg.type) lines.push(`- module type: ${pkg.type}`);
    if (pkg.main) lines.push(`- entry: ${pkg.main}`);
    const scriptKeys = ['build', 'test', 'start', 'dev', 'lint'];
    const scripts = scriptKeys.filter(k => pkg.scripts?.[k]);
    if (scripts.length > 0) {
      lines.push(`- npm scripts available: ${scripts.map(s => `\`${s}\``).join(', ')}`);
    }
    if (lines.length === 0) return null;
    return `### package.json\n${lines.join('\n')}`;
  } catch {
    return null;
  }
}

async function readTsConfig(cwd: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(cwd, 'tsconfig.json'), 'utf-8');
    // tsconfig allows JSON comments — strip them before parsing.
    const cleaned = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const tsc = JSON.parse(cleaned);
    const co = tsc.compilerOptions ?? {};
    const lines: string[] = [];
    if (co.target) lines.push(`- target: ${co.target}`);
    if (co.module) lines.push(`- module: ${co.module}`);
    if (co.strict !== undefined) lines.push(`- strict: ${co.strict}`);
    if (co.outDir) lines.push(`- outDir: ${co.outDir}`);
    if (lines.length === 0) return null;
    return `### tsconfig.json\n${lines.join('\n')}`;
  } catch {
    return null;
  }
}

async function readPythonMarkers(cwd: string): Promise<string | null> {
  const markers: string[] = [];
  for (const file of ['pyproject.toml', 'requirements.txt', 'setup.py']) {
    try {
      await fs.access(path.join(cwd, file));
      markers.push(file);
    } catch {
      // ignore
    }
  }
  if (markers.length === 0) return null;
  return `### Python\n- markers present: ${markers.join(', ')}`;
}
