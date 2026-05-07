import type { ToolDefinition, ToolHandler } from './types.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import { bashTool } from './bash.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { webFetchTool } from './web-fetch.js';

export class ToolRegistry {
  // Canonical store keyed by the handler's exact name. `getAll()` iterates
  // only this map, so callers get one entry per tool without a Set dedup.
  private tools: Map<string, ToolHandler> = new Map();
  // Lookup index for the case-insensitive fallback in `get()`. Models
  // sometimes lowercase tool names (`bash` instead of `Bash`); without
  // this, every such call would miss and trip the corrector. Keeping it
  // as a separate index (rather than double-inserting into `tools`) means
  // `getAll()` doesn't have to dedup and is the natural shape for the
  // intended access pattern.
  private byLowerName: Map<string, ToolHandler> = new Map();

  constructor(options: { empty?: boolean } = {}) {
    // Default behavior auto-registers the built-ins. Pass `{ empty: true }`
    // to skip — used by the subagent runner, which wants an explicit
    // allow-list (Read/Glob/Grep + a hardened Bash) and was previously
    // forced to register-then-unregister every default tool just to clear
    // the slate.
    if (options.empty) return;
    this.register(readTool);
    this.register(writeTool);
    this.register(editTool);
    this.register(bashTool);
    this.register(globTool);
    this.register(grepTool);
    this.register(webFetchTool);
  }

  register(handler: ToolHandler): void {
    this.tools.set(handler.name, handler);
    this.byLowerName.set(handler.name.toLowerCase(), handler);
  }

  unregister(name: string): void {
    const handler = this.tools.get(name) ?? this.byLowerName.get(name.toLowerCase());
    if (!handler) return;
    this.tools.delete(handler.name);
    this.byLowerName.delete(handler.name.toLowerCase());
  }

  get(name: string): ToolHandler | undefined {
    return this.tools.get(name) ?? this.byLowerName.get(name.toLowerCase());
  }

  getAll(): ToolHandler[] {
    return [...this.tools.values()];
  }

  getDefinitions(): ToolDefinition[] {
    return this.getAll().map(t => t.definition);
  }

  getNames(): string[] {
    return this.getAll().map(t => t.name);
  }
}
