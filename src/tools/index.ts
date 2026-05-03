import type { ToolDefinition, ToolHandler } from './types.js';
import { ToolRegistry } from './registry.js';

/** Default shared registry with all built-in tools */
export const defaultRegistry = new ToolRegistry();

export function getToolDefinitions(): ToolDefinition[] {
  return defaultRegistry.getDefinitions();
}

export function getTool(name: string): ToolHandler | undefined {
  return defaultRegistry.get(name);
}

export function getAllTools(): ToolHandler[] {
  return defaultRegistry.getAll();
}

export { ToolRegistry } from './registry.js';
export type { ToolHandler, ToolResult, ToolDefinition, ToolCategory } from './types.js';
