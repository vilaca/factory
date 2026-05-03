import React, { useState } from 'react';
import { Box, Text, useApp, useInput, render } from 'ink';
import chalk from 'chalk';
import type { RecentSession, SessionErrorStatus } from '../core/session-log.js';
import type { StartupProviderName } from '../providers/descriptors.js';
import type { PickerOption } from './picker.js';
import { exitStartupSelection } from './prompts.js';

export interface StartupSelection {
  provider: StartupProviderName;
  /** Set when the user picked a recent (provider, model) pair directly. */
  model?: string;
}

function shortcutFor(index: number): string {
  if (index < 10) return index.toString();
  if (index < 36) return String.fromCharCode('A'.charCodeAt(0) + index - 10);
  return '';
}

function indexForShortcut(input: string): number {
  if (/^[0-9]$/.test(input)) return Number.parseInt(input, 10);
  const upper = input.toUpperCase();
  if (/^[A-Z]$/.test(upper)) return 10 + (upper.charCodeAt(0) - 'A'.charCodeAt(0));
  return -1;
}

const STATUS_LABELS: Record<SessionErrorStatus, string> = {
  throttle: 'throttled',
  quota: 'out of quota',
  permission: 'permission denied',
  error: 'error',
};
const STATUS_COLORS: Record<SessionErrorStatus, (s: string) => string> = {
  throttle: chalk.yellow,
  quota: chalk.red,
  permission: chalk.red,
  error: chalk.red,
};

interface RowProps {
  selected: boolean;
  shortcut: string;
  label: string;
  suffix?: string;
  dim?: boolean;
}

function Row({ selected, shortcut, label, suffix, dim }: RowProps): React.ReactElement {
  const cursor = selected ? chalk.cyan('▸ ') : '  ';
  const num = shortcut ? `${shortcut}. ` : '';
  const text = selected ? chalk.cyan.bold(label) : label;
  const line = `    ${cursor}${num}${text}${suffix ? '  ' + suffix : ''}`;
  return <Text dimColor={dim && !selected}>{line}</Text>;
}

interface AppProps {
  recentSessions: RecentSession[];
  providerOptions: PickerOption[];
  defaultProviderIndex: number;
  onResolve: (sel: StartupSelection | null) => void;
}

function StartupMenuApp({
  recentSessions,
  providerOptions,
  defaultProviderIndex,
  onResolve,
}: AppProps): React.ReactElement {
  const recentRows = recentSessions.length;
  // Last row of the recent menu is the "Pick a different provider" entry.
  const recentLastIdx = recentRows;

  // A recent session shares the offline state of its underlying provider — if
  // the provider didn't probe successfully at startup, picking it would
  // immediately fail downstream, so block selection at the menu level.
  const offlineByProvider = new Map<string, boolean>(
    providerOptions.map(o => [o.descriptor.name, !!o.offline]),
  );
  const isRecentOffline = (i: number): boolean =>
    offlineByProvider.get(recentSessions[i]?.provider) === true;
  const isProviderOffline = (i: number): boolean => !!providerOptions[i]?.offline;

  // Initial cursor lands on the first non-offline row so Enter immediately
  // works. If everything is offline (recent menu only), drop to the
  // "Pick a different provider" entry; in the provider menu, fall back to 0.
  const initialRecentIdx = (() => {
    const i = recentSessions.findIndex(s => !offlineByProvider.get(s.provider));
    return i >= 0 ? i : recentLastIdx;
  })();
  const initialProviderIdx = providerOptions[defaultProviderIndex]?.offline
    ? Math.max(0, providerOptions.findIndex(o => !o.offline))
    : defaultProviderIndex;

  const [screen, setScreen] = useState<'recent' | 'provider'>(
    recentRows > 0 ? 'recent' : 'provider',
  );
  const [recentIdx, setRecentIdx] = useState(initialRecentIdx);
  const [providerIdx, setProviderIdx] = useState(initialProviderIdx);
  const { exit } = useApp();

  const finish = (sel: StartupSelection | null): void => {
    onResolve(sel);
    exit();
  };

  useInput((input, key) => {
    if (input === 'q' || input === 'Q' || (key.ctrl && input === 'c')) {
      finish(null);
      return;
    }

    if (screen === 'recent') {
      if (key.upArrow) {
        setRecentIdx(i => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setRecentIdx(i => Math.min(recentLastIdx, i + 1));
      } else if (key.return || input === ' ') {
        if (recentIdx === recentLastIdx) {
          setScreen('provider');
        } else if (!isRecentOffline(recentIdx)) {
          const s = recentSessions[recentIdx];
          finish({ provider: s.provider as StartupProviderName, model: s.model });
        }
      } else if (input === 'p' || input === 'P') {
        setScreen('provider');
      } else {
        const idx = indexForShortcut(input);
        if (idx >= 0 && idx < recentRows && !isRecentOffline(idx)) {
          finish({
            provider: recentSessions[idx].provider as StartupProviderName,
            model: recentSessions[idx].model,
          });
        }
      }
      return;
    }

    // provider screen
    if (key.upArrow) {
      setProviderIdx(i => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setProviderIdx(i => Math.min(providerOptions.length - 1, i + 1));
    } else if (key.return || input === ' ') {
      if (!isProviderOffline(providerIdx)) {
        finish({ provider: providerOptions[providerIdx].descriptor.name });
      }
    } else if (key.escape && recentRows > 0) {
      setScreen('recent');
    } else {
      const idx = indexForShortcut(input);
      if (idx >= 0 && idx < providerOptions.length && !isProviderOffline(idx)) {
        finish({ provider: providerOptions[idx].descriptor.name });
      }
    }
  });

  if (screen === 'recent') {
    return (
      <Box flexDirection="column">
        <Text bold>{'  Recent sessions:'}</Text>
        <Text> </Text>
        {recentSessions.map((s, i) => {
          const offline = isRecentOffline(i);
          const statusSuffix = s.status
            ? STATUS_COLORS[s.status](`(${STATUS_LABELS[s.status]})`)
            : '';
          const offlineSuffix = offline ? chalk.dim('(offline)') : '';
          const suffix = [statusSuffix, offlineSuffix].filter(Boolean).join('  ');
          return (
            <Row
              key={i}
              selected={i === recentIdx}
              shortcut={shortcutFor(i)}
              label={`${s.provider} / ${s.model}`}
              suffix={suffix}
              dim={offline}
            />
          );
        })}
        <Text> </Text>
        <Row
          selected={recentIdx === recentLastIdx}
          shortcut="P"
          label="Pick a different provider"
        />
        <Text> </Text>
        <Text dimColor>{'     ↑/↓ navigate · ↵ / space select · 0-9 jump · Q exit'}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>{'  Select a provider:'}</Text>
      <Text> </Text>
      {providerOptions.map((opt, i) => (
        <Row
          key={opt.descriptor.name}
          selected={i === providerIdx}
          shortcut={shortcutFor(i)}
          label={opt.descriptor.label}
          suffix={opt.offline ? chalk.dim('(offline)') : ''}
          dim={opt.offline}
        />
      ))}
      <Text> </Text>
      <Text dimColor>
        {`     ↑/↓ navigate · ↵ / space select · 0-9 / A-Z jump · ${recentRows > 0 ? 'Esc back · ' : ''}Q exit`}
      </Text>
    </Box>
  );
}

export async function selectStartupSession(
  recentSessions: RecentSession[],
  providerOptions: PickerOption[],
  defaultSelection?: { provider: StartupProviderName; model?: string },
): Promise<StartupSelection> {
  const defaultProviderIndex = Math.max(
    0,
    providerOptions.findIndex(o => o.descriptor.name === defaultSelection?.provider),
  );

  const debug = process.env.FACTORY_DEBUG === '1';
  const dbg = (msg: string): void => {
    if (debug) process.stderr.write(`[factory:debug] startup-menu: ${msg}\n`);
  };

  let result: StartupSelection | null = null;
  const inkApp = render(
    <StartupMenuApp
      recentSessions={recentSessions}
      providerOptions={providerOptions}
      defaultProviderIndex={defaultProviderIndex}
      onResolve={(sel) => { dbg(`onResolve sel=${JSON.stringify(sel)}`); result = sel; }}
    />,
  );
  dbg('rendered, waiting for exit');
  await inkApp.waitUntilExit();
  dbg(`waitUntilExit resolved, result=${JSON.stringify(result)}`);
  inkApp.unmount();
  // Ink keeps stdin in raw/paused state in some terminals; restore it
  // explicitly so subsequent readline-based prompts (selectModel) work.
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(false);
  }
  process.stdin.resume();
  dbg('stdin restored, returning');
  if (result === null) exitStartupSelection();
  return result;
}
