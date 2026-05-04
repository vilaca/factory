import type { AgentLoopApi } from '../agent-loop/types.js';

// Stores a getter, not the API object. AgentLoopApi changes every render, but
// each Session keeps its api in a ref and exposes a stable getter — so the
// registration survives re-renders.
type ApiGetter = () => AgentLoopApi;

export class TabsRegistry {
  private getters = new Map<number, ApiGetter>();
  private listeners = new Set<() => void>();

  register(id: number, getter: ApiGetter): void {
    this.getters.set(id, getter);
    this.notify();
  }

  unregister(id: number): void {
    const had = this.getters.delete(id);
    if (had) this.notify();
  }

  get(id: number): AgentLoopApi | undefined {
    return this.getters.get(id)?.();
  }

  has(id: number): boolean {
    return this.getters.has(id);
  }

  size(): number {
    return this.getters.size;
  }

  ids(): number[] {
    return Array.from(this.getters.keys());
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}
