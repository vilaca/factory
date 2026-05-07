import React, { useEffect } from 'react';
import { useApp, useInput } from 'ink';
import type { Provider } from '../../providers/types.js';
import type { AgentConfig } from '../../core/config-types.js';
import { Session } from './Session.js';
import { TabsProvider } from './tabs/TabsContext.js';
import { useTabs } from './tabs/use-tabs.js';

// F1–F12 escape sequences. Most terminals send xterm-style for F1-F4
// (ESC O letter) and CSI for F5+; the bracket-style F1-F4 forms
// (\x1b[11~ etc.) are emitted by VT220 and a few minority terminals,
// so we accept both. Ink's useInput drops F-keys (no Key.fN flag and
// `input` is forced to '' for non-alphanumeric keys), so we listen to
// process.stdin directly at the parent level.
const FN_KEY_TO_INDEX: ReadonlyMap<string, number> = new Map([
  ['\x1bOP', 0],
  ['\x1b[11~', 0],
  ['\x1bOQ', 1],
  ['\x1b[12~', 1],
  ['\x1bOR', 2],
  ['\x1b[13~', 2],
  ['\x1bOS', 3],
  ['\x1b[14~', 3],
  ['\x1b[15~', 4],
  ['\x1b[17~', 5],
  ['\x1b[18~', 6],
  ['\x1b[19~', 7],
  ['\x1b[20~', 8],
  ['\x1b[21~', 9],
  ['\x1b[23~', 10],
  ['\x1b[24~', 11],
]);

export interface AppProps {
  model: string;
  systemPrompt: string;
  provider: Provider;
  /** Id of the multi-key-store entry the launch provider was built with.
   *  Forwarded to each Session so per-key stats attribute correctly from
   *  the first turn. */
  keyId?: string;
  agentConfig?: AgentConfig;
  autoAllowTools?: string[];
  useTextToolFallback?: boolean;
  nativeToolSupport?: boolean;
  enableSessionLog?: boolean;
  strictLogging?: boolean;
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
  const { tabs, activeId, openTab, closeTab, cycle, switchToIndex, registry } = useTabs();
  const { exit } = useApp();

  // F-key tab selection. Ink doesn't expose F-keys via useInput (see comment
  // on FN_KEY_TO_INDEX), so we tap process.stdin directly. Multiple stdin
  // 'data' listeners coexist — ink's parser still runs in parallel and
  // simply produces input='' for these keys.
  useEffect(() => {
    const handler = (chunk: Buffer): void => {
      const seq = chunk.toString();
      const idx = FN_KEY_TO_INDEX.get(seq);
      if (idx !== undefined) switchToIndex(idx);
    };
    process.stdin.on('data', handler);
    return () => {
      process.stdin.off('data', handler);
    };
  }, [switchToIndex]);

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
      {tabs.map(tab => (
        <Session
          key={tab.id}
          tabId={tab.id}
          tabLabel={tab.label}
          isActive={tab.id === activeId}
          {...props}
        />
      ))}
    </>
  );
}
