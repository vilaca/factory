import type { AgentLoopApi } from '../agent-loop/types.js';

// Stores a getter, not the API object. AgentLoopApi changes every render, but
// each Session keeps its api in a ref and exposes a stable getter — so the
// registration survives re-renders.
type ApiGetter = () => AgentLoopApi;

export type SessionBadge = 'running' | 'awaiting-permission' | 'attention' | null;

export interface SessionStatus {
  badge: SessionBadge;
}

const EMPTY_STATUS: SessionStatus = Object.freeze({ badge: null });

export class TabsRegistry {
  private getters = new Map<number, ApiGetter>();
  private statuses = new Map<number, SessionStatus>();
  private listeners = new Set<() => void>();

  register(id: number, getter: ApiGetter): void {
    this.getters.set(id, getter);
    if (!this.statuses.has(id)) this.statuses.set(id, EMPTY_STATUS);
    this.notify();
  }

  unregister(id: number): void {
    const had = this.getters.delete(id);
    this.statuses.delete(id);
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

  setStatus(id: number, status: SessionStatus): void {
    if (!this.getters.has(id)) return;
    const prev = this.statuses.get(id) ?? EMPTY_STATUS;
    if (prev.badge === status.badge) return;
    this.statuses.set(id, status);
    this.notify();
  }

  getStatus(id: number): SessionStatus {
    return this.statuses.get(id) ?? EMPTY_STATUS;
  }

  // Coarse subscription: fires on register/unregister and on setStatus changes.
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}
