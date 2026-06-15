/**
 * Tool seam (boundary surface between core/ and tools/).
 *
 * core/ may import from this file plus `utils/tool-names.ts` and
 * `utils/tool-definition.ts` — and from no other file inside tools/.
 * The arch test in `test/unit/arch/modularity.test.ts` enforces it.
 *
 * Why a seam in tools/ rather than utils/: the tool-author types
 * (`ToolHandler` → `ToolContext` → `PathPolicy`/`EnvPolicy`) reach into
 * `src/security/`, and the security primitive cannot be imported from
 * utils/. Keeping the seam in tools/ — and exposing only this file to
 * core/ — gets the same boundary without fighting the security rule.
 *
 * What core gets:
 *   - `ToolHost` — read-only view of the registry (no register/unregister).
 *   - `ToolHandler` / `ToolResult` / `ExecutedToolResult` / `ToolContext`
 *     — the runtime types core needs to invoke tools.
 *   - `ToolResolutionError` — the soft-failure exception class.
 *   - Re-exports of `TOOL_NAMES` and `ToolDefinition` / `ToolPrerequisite`
 *     (whose canonical home is utils/, where providers and security can
 *     also reach them).
 *
 * What core does NOT get:
 *   - `ToolRegistry` (concrete impl, has `register`/`unregister`).
 *   - Any concrete tool handler module (bash.ts, read.ts, …).
 */

import type { ToolDefinition } from '../utils/tool-definition.js';
import type { ToolHandler } from './types.js';

export type { ToolHandler, ToolResult, ExecutedToolResult } from './types.js';
export type { ToolDefinition, ToolPrerequisite } from '../utils/tool-definition.js';
export { TOOL_NAMES } from '../utils/tool-names.js';
export { ToolResolutionError } from './errors.js';

/**
 * Read-only view of a tool registry. Core depends only on this surface;
 * the concrete `ToolRegistry` class in `./registry.ts` `implements` it
 * and additionally exposes mutation (`register`/`unregister`) used by
 * startup wiring in `cli/startup/`.
 */
export interface ToolHost {
  get(name: string): ToolHandler | undefined;
  getAll(): ToolHandler[];
  getDefinitions(opts?: { exclude?: ReadonlySet<string> }): ToolDefinition[];
  getNames(): string[];
}
