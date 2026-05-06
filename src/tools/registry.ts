import type { ToolDefinition, ToolHandler } from './types.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import { bashTool } from './bash.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { webFetchTool } from './web-fetch.js';

export class ToolRegistry {
  private tools: Map<string, ToolHandler> = new Map();

  constructor() {
    // Register built-in tools
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
    this.tools.set(handler.name.toLowerCase(), handler);
  }

  unregister(name: string): void {
    const tool = this.tools.get(name) ?? this.tools.get(name.toLowerCase());
    if (tool) {
      this.tools.delete(tool.name);
      this.tools.delete(tool.name.toLowerCase());
    }
  }

  get(name: string): ToolHandler | undefined {
    return this.tools.get(name) ?? this.tools.get(name.toLowerCase());
  }

  getAll(): ToolHandler[] {
    // Deduplicate (both name and lowercase entries point to same handler)
    return [...new Set(this.tools.values())];
  }

  getDefinitions(): ToolDefinition[] {
    return this.getAll().map(t => t.definition);
  }

  getNames(): string[] {
    return this.getAll().map(t => t.name);
  }
}
