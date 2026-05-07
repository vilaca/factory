import React, { createContext, useState, useRef, useCallback, useMemo } from 'react';
import { TabsRegistry } from './tabs-registry.js';

interface Tab {
  id: number;
  label: string;
}

export interface TabsContextValue {
  tabs: Tab[];
  activeId: number;
  registry: TabsRegistry;
  /** Tab ids that are currently blocked on user input (permission, plan approval). */
  waitingTabs: ReadonlySet<number>;
  openTab(label?: string): number;
  closeTab(id: number): void;
  switchTo(id: number): void;
  switchToIndex(index: number): void;
  cycle(direction: 1 | -1): void;
  setLabel(id: number, label: string): void;
  setWaiting(id: number, waiting: boolean): void;
}

export const TabsContext = createContext<TabsContextValue | null>(null);

interface TabsProviderProps {
  children: React.ReactNode;
  initialLabel?: string;
}

export function TabsProvider(props: TabsProviderProps): React.ReactElement {
  // The initial tab is "main"; subsequent unnamed tabs become `tab-<id>`.
  // The id is monotonic and never reused, so labels stay unique after closes.
  const initialLabel = props.initialLabel ?? 'main';
  const [tabs, setTabs] = useState<Tab[]>([{ id: 1, label: initialLabel }]);
  const [activeId, setActiveId] = useState<number>(1);
  const [waitingTabs, setWaitingTabs] = useState<ReadonlySet<number>>(() => new Set());
  const nextId = useRef<number>(2);
  const registryRef = useRef<TabsRegistry>(new TabsRegistry());

  const openTab = useCallback((label?: string): number => {
    const id = nextId.current++;
    setTabs(prev => [...prev, { id, label: label ?? `tab-${id}` }]);
    setActiveId(id);
    return id;
  }, []);

  const closeTab = useCallback((id: number): void => {
    setTabs(prevTabs => {
      const idx = prevTabs.findIndex(t => t.id === id);
      if (idx === -1) return prevTabs;
      const next = prevTabs.filter(t => t.id !== id);
      // Don't allow closing the last tab here — caller (e.g. /exit) handles
      // process exit explicitly.
      if (next.length === 0) return prevTabs;
      setActiveId(currId => {
        if (currId !== id) return currId;
        return next[Math.max(0, idx - 1)]!.id;
      });
      return next;
    });
    registryRef.current.unregister(id);
    setWaitingTabs(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const setWaiting = useCallback((id: number, waiting: boolean): void => {
    setWaitingTabs(prev => {
      const has = prev.has(id);
      if (waiting && !has) {
        const next = new Set(prev);
        next.add(id);
        return next;
      }
      if (!waiting && has) {
        const next = new Set(prev);
        next.delete(id);
        return next;
      }
      return prev;
    });
  }, []);

  const switchTo = useCallback((id: number): void => {
    setActiveId(prev => (registryRef.current.has(id) ? id : prev));
  }, []);

  const switchToIndex = useCallback((index: number): void => {
    setTabs(prev => {
      if (index < 0 || index >= prev.length) return prev;
      setActiveId(prev[index]!.id);
      return prev;
    });
  }, []);

  // Read both tabs and activeId via the functional setter form so rapid
  // sequential cycles within a single React batch don't re-read a stale
  // activeId from closure.
  const cycle = useCallback((direction: 1 | -1): void => {
    setTabs(prevTabs => {
      if (prevTabs.length <= 1) return prevTabs;
      setActiveId(prevActive => {
        const idx = prevTabs.findIndex(t => t.id === prevActive);
        if (idx === -1) return prevActive;
        const nextIdx = (idx + direction + prevTabs.length) % prevTabs.length;
        return prevTabs[nextIdx]!.id;
      });
      return prevTabs;
    });
  }, []);

  const setLabel = useCallback((id: number, label: string): void => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, label } : t));
  }, []);

  const value = useMemo<TabsContextValue>(
    () => ({
      tabs,
      activeId,
      registry: registryRef.current,
      waitingTabs,
      openTab,
      closeTab,
      switchTo,
      switchToIndex,
      cycle,
      setLabel,
      setWaiting,
    }),
    [tabs, activeId, waitingTabs, openTab, closeTab, switchTo, switchToIndex, cycle, setLabel, setWaiting],
  );

  return <TabsContext.Provider value={value}>{props.children}</TabsContext.Provider>;
}
