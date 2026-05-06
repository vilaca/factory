import fs from 'fs/promises';
import path from 'path';
import { globToRegex } from '../utils/glob.js';

export async function extractProjectFacts(cwd: string): Promise<string | null> {
  const sections: string[] = [];

  const pkgFacts = await readPackageJson(cwd);
  if (pkgFacts) sections.push(pkgFacts);

  const tscFacts = await readTsConfig(cwd);
  if (tscFacts) sections.push(tscFacts);

  const cargoFacts = await readCargoToml(cwd);
  if (cargoFacts) sections.push(cargoFacts);

  const goFacts = await readGoMod(cwd);
  if (goFacts) sections.push(goFacts);

  const pyFacts = await readMarkers(cwd, 'Python', ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'poetry.lock']);
  if (pyFacts) sections.push(pyFacts);

  const javaFacts = await readMarkers(cwd, 'JVM (Java/Kotlin/Scala)', [
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'build.sbt',
  ]);
  if (javaFacts) sections.push(javaFacts);

  const rubyFacts = await readMarkers(cwd, 'Ruby', ['Gemfile', 'Gemfile.lock', '*.gemspec']);
  if (rubyFacts) sections.push(rubyFacts);

  const phpFacts = await readMarkers(cwd, 'PHP', ['composer.json', 'composer.lock']);
  if (phpFacts) sections.push(phpFacts);

  const elixirFacts = await readMarkers(cwd, 'Elixir', ['mix.exs', 'mix.lock']);
  if (elixirFacts) sections.push(elixirFacts);

  const cppFacts = await readMarkers(cwd, 'C/C++', ['CMakeLists.txt', 'Makefile', 'configure', 'meson.build']);
  if (cppFacts) sections.push(cppFacts);

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

async function readMarkers(cwd: string, label: string, files: string[]): Promise<string | null> {
  const markers: string[] = [];
  for (const file of files) {
    if (file.includes('*')) {
      const dirEntries = await fs.readdir(cwd).catch(() => [] as string[]);
      const re = globToRegex(file);
      if (dirEntries.some((e) => re.test(e))) markers.push(file);
      continue;
    }
    try {
      await fs.access(path.join(cwd, file));
      markers.push(file);
    } catch {
      // ignore
    }
  }
  if (markers.length === 0) return null;
  return `### ${label}\n- markers present: ${markers.join(', ')}`;
}

async function readCargoToml(cwd: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(cwd, 'Cargo.toml'), 'utf-8');
    const lines: string[] = [];
    const name = raw.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    const version = raw.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
    const edition = raw.match(/^\s*edition\s*=\s*"([^"]+)"/m)?.[1];
    if (name) lines.push(`- name: ${name}${version ? `@${version}` : ''}`);
    if (edition) lines.push(`- edition: ${edition}`);
    if (lines.length === 0) return null;
    return `### Cargo.toml\n${lines.join('\n')}`;
  } catch {
    return null;
  }
}

async function readGoMod(cwd: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(cwd, 'go.mod'), 'utf-8');
    const lines: string[] = [];
    const moduleName = raw.match(/^module\s+(\S+)/m)?.[1];
    const goVersion = raw.match(/^go\s+(\S+)/m)?.[1];
    if (moduleName) lines.push(`- module: ${moduleName}`);
    if (goVersion) lines.push(`- go version: ${goVersion}`);
    if (lines.length === 0) return null;
    return `### go.mod\n${lines.join('\n')}`;
  } catch {
    return null;
  }
}
