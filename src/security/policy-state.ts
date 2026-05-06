// Process-level policy state for security primitives.
//
// Why a singleton: ToolHandler.execute(args) has no context parameter, so
// tools can't reach into the agent loop for policy. Threading a context
// through every tool would touch every caller (REPL, headless, tests). A
// process-wide setter is fine because:
//   - factory runs one agent at a time per process
//   - policy is set once at startup from config and never mutated mid-run
//   - tests can call setPathPolicy() in beforeEach to inject overrides

import type { PathPolicy } from './paths.js';
import type { EnvPolicy } from './env.js';

let pathPolicy: PathPolicy = {};
let envPolicy: EnvPolicy = {};

export function setPathPolicy(p: PathPolicy): void {
  pathPolicy = p;
}

export function getPathPolicy(): PathPolicy {
  return pathPolicy;
}

export function setEnvPolicy(p: EnvPolicy): void {
  envPolicy = p;
}

export function getEnvPolicy(): EnvPolicy {
  return envPolicy;
}

export function resetPolicyState(): void {
  pathPolicy = {};
  envPolicy = {};
}
