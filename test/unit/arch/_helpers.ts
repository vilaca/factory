import assert from 'node:assert';
import path from 'node:path';
import { Project } from 'ts-morph';

// Shared utilities for architecture rules. Each *.test.ts file in this
// folder describes one rule category (§A-§F in MODULARITY_RULES.md) and
// imports from here so the ts-morph project is parsed exactly once
// across the suite.

let _morphProject: Project | undefined;
export function getMorphProject(): Project {
  _morphProject ??= new Project({ tsConfigFilePath: 'tsconfig.json' });
  return _morphProject;
}

export function relPath(absolute: string): string {
  return path.relative(process.cwd(), absolute);
}

export async function expectNoViolations(
  rule: { check: () => Promise<unknown[]> },
  label: string,
): Promise<void> {
  const violations = await rule.check();
  assert.deepStrictEqual(
    violations,
    [],
    `${label} — ${violations.length} violation(s):\n${JSON.stringify(violations, null, 2)}`,
  );
}
