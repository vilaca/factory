import { ToolRegistry } from './registry.js';

/** Default shared registry with all built-in tools. Callers consume the
 *  registry methods directly (`getAll`, `get`, `getDefinitions`) — there
 *  is no separate function-style facade. */
export const defaultRegistry = new ToolRegistry();
