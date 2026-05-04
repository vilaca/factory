import React, { useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import { useTabs } from './use-tabs.js';
import type { TabsRegistry, SessionBadge } from './tabs-registry.js';

function useBadge(registry: TabsRegistry, tabId: number): SessionBadge {
  return useSyncExternalStore(
    (cb) => registry.subscribe(cb),
    () => registry.getStatus(tabId).badge,
  );
}

function badgeGlyph(badge: SessionBadge): { glyph: string; color?: string } | null {
  if (badge === 'running') return { glyph: '…', color: 'yellow' };
  if (badge === 'awaiting-permission') return { glyph: '❗', color: 'magenta' };
  if (badge === 'attention') return { glyph: '✓', color: 'green' };
  return null;
}

function TabEntry({ id, label, isActive, index, registry }: {
  id: number;
  label: string;
  isActive: boolean;
  index: number;
  registry: TabsRegistry;
}): React.ReactElement {
  const badge = useBadge(registry, id);
  const b = badgeGlyph(badge);
  return (
    <Text>
      {' '}
      <Text color={isActive ? 'cyan' : undefined} bold={isActive} dimColor={!isActive}>
        {isActive ? '●' : '○'} {index + 1}: {label}
      </Text>
      {b && (
        <>
          {' '}
          <Text color={b.color}>{b.glyph}</Text>
        </>
      )}
    </Text>
  );
}

// Single-tab note: the strip renders even when there's only one tab so the UI
// surface is consistent (and so users discover the feature).
export function TabStrip(): React.ReactElement | null {
  const { tabs, activeId, registry } = useTabs();
  if (tabs.length === 0) return null;
  return (
    <Box paddingX={1}>
      {tabs.map((tab, i) => (
        <TabEntry
          key={tab.id}
          id={tab.id}
          label={tab.label}
          isActive={tab.id === activeId}
          index={i}
          registry={registry}
        />
      ))}
    </Box>
  );
}
