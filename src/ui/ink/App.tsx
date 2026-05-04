import React from 'react';
import { useApp, useInput } from 'ink';
import type { Provider } from '../../providers/types.js';
import type { AgentConfig } from '../../core/config-types.js';
import { Session } from './Session.js';
import { TabsProvider } from './tabs/TabsContext.js';
import { useTabs } from './tabs/use-tabs.js';
import { TabStrip } from './tabs/TabStrip.js';

export interface AppProps {
  model: string;
  systemPrompt: string;
  provider: Provider;
  agentConfig?: AgentConfig;
  autoAllowTools?: string[];
  useTextToolFallback?: boolean;
  nativeToolSupport?: boolean;
  enableSessionLog?: boolean;
  planMode?: boolean;
  enableCorrector?: boolean;
  mcpInfo?: { servers: string[]; toolCount: number };
  gitBranch?: string;
  gitDirty?: boolean | null;
  validationWarning?: string;
}

export function App(props: AppProps): React.ReactElement {
  return (
    <TabsProvider>
      <TabbedApp {...props} />
    </TabsProvider>
  );
}

function TabbedApp(props: AppProps): React.ReactElement {
  const { tabs, activeId, openTab, closeTab, cycle, registry } = useTabs();
  const { exit } = useApp();

  // Parent-level hotkeys for tab management. Ink fires both this listener and
  // the active Session's listener, so the keys here must not collide with the
  // Session's keys (Ctrl+C, Esc, Up/Down). These do not.
  // Note: terminals don't reliably send Ctrl+digit or Ctrl+Tab, so switch by
  // index/cycle uses Ctrl+N/Ctrl+P plus the /switch slash command.
  useInput((input, key) => {
    if (!key.ctrl) return;
    if (input === 't') {
      openTab();
      return;
    }
    if (input === 'w') {
      if (tabs.length === 1) {
        // Last tab: aborting the active session and exiting matches /exit.
        const api = registry.get(activeId);
        api?.abort();
        exit();
        setTimeout(() => process.exit(0), 1000).unref();
        return;
      }
      const api = registry.get(activeId);
      api?.abort();
      closeTab(activeId);
      return;
    }
    if (input === 'n') {
      cycle(1);
      return;
    }
    if (input === 'p') {
      cycle(-1);
      return;
    }
  });

  return (
    <>
      <TabStrip />
      {tabs.map(tab => (
        <Session
          key={tab.id}
          tabId={tab.id}
          isActive={tab.id === activeId}
          {...props}
        />
      ))}
    </>
  );
}
