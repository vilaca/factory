import React, { createContext, useState, useRef, useCallback, useMemo } from 'react';
import { TabsRegistry } from './tabs-registry.js';

export interface Tab {
  id: number;
  label: string;
}

export interface TabsContextValue {
  tabs: Tab[];
  activeId: number;
  registry: TabsRegistry;
  openTab(label?: string): number;
  closeTab(id: number): void;
  switchTo(id: number): void;
  switchToIndex(index: number): void;
  cycle(direction: 1 | -1): void;
  setLabel(id: number, label: string): void;
}

export const TabsContext = createContext<TabsContextValue | null>(null);

export interface TabsProviderProps {
  children: React.ReactNode;
  initialLabel?: string;
}

export function TabsProvider(props: TabsProviderProps): React.ReactElement {
  const initialLabel = props.initialLabel ?? 'main';
  const [tabs, setTabs] = useState<Tab[]>([{ id: 1, label: initialLabel }]);
  const [activeId, setActiveId] = useState<number>(1);
  const nextId = useRef<number>(2);
  const registryRef = useRef<TabsRegistry>(new TabsRegistry());

  const openTab = useCallback((label = 'new'): number => {
    const id = nextId.current++;
    setTabs(prev => [...prev, { id, label }]);
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

  const cycle = useCallback((direction: 1 | -1): void => {
    setTabs(prev => {
      if (prev.length <= 1) return prev;
      const idx = prev.findIndex(t => t.id === activeId);
      if (idx === -1) return prev;
      const nextIdx = (idx + direction + prev.length) % prev.length;
      setActiveId(prev[nextIdx]!.id);
      return prev;
    });
  }, [activeId]);

  const setLabel = useCallback((id: number, label: string): void => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, label } : t));
  }, []);

  const value = useMemo<TabsContextValue>(
    () => ({
      tabs,
      activeId,
      registry: registryRef.current,
      openTab,
      closeTab,
      switchTo,
      switchToIndex,
      cycle,
      setLabel,
    }),
    [tabs, activeId, openTab, closeTab, switchTo, switchToIndex, cycle, setLabel],
  );

  return <TabsContext.Provider value={value}>{props.children}</TabsContext.Provider>;
}
