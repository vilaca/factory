import { useContext } from 'react';
import { TabsContext, type TabsContextValue } from './TabsContext.js';

export function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) {
    throw new Error('useTabs() called outside <TabsProvider>');
  }
  return ctx;
}
