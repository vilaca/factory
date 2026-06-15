import type { ToolDefinition, ToolHandler } from './types.js';
import type { ToolHost } from './host.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import { bashTool } from './bash.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { webFetchTool } from './web/index.js';
import { respondTool } from './respond.js';

export class ToolRegistry implements ToolHost {
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
    // Synthetic Respond tool: gives small models a structured terminal
    // action instead of guessing between "emit text" and "call a tool".
    // The runtime handler is always available; the agent loop decides per
    // turn whether to expose it on the wire (see `getDefinitions({ exclude })`
    // and the auto-enable rule in `run-agent.ts`).
    this.register(respondTool);
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

  getDefinitions(opts?: { exclude?: ReadonlySet<string> }): ToolDefinition[] {
    const exclude = opts?.exclude;
    const all = this.getAll();
    return exclude && exclude.size > 0
      ? all.filter(t => !exclude.has(t.name)).map(t => t.definition)
      : all.map(t => t.definition);
  }

  getNames(): string[] {
    return this.getAll().map(t => t.name);
  }
}
