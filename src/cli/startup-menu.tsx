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
}

function Row({ selected, shortcut, label, suffix }: RowProps): React.ReactElement {
  const cursor = selected ? chalk.cyan('▸ ') : '  ';
  const num = shortcut ? `${shortcut}. ` : '';
  const text = selected ? chalk.cyan.bold(label) : label;
  return <Text>{`    ${cursor}${num}${text}${suffix ? '  ' + suffix : ''}`}</Text>;
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
  const [screen, setScreen] = useState<'recent' | 'provider'>(
    recentRows > 0 ? 'recent' : 'provider',
  );
  const [recentIdx, setRecentIdx] = useState(0);
  const [providerIdx, setProviderIdx] = useState(defaultProviderIndex);
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
        } else {
          const s = recentSessions[recentIdx];
          finish({ provider: s.provider as StartupProviderName, model: s.model });
        }
      } else if (input === 'p' || input === 'P') {
        setScreen('provider');
      } else if (/^[0-9]$/.test(input)) {
        const num = Number.parseInt(input, 10);
        if (num < recentRows) {
          finish({
            provider: recentSessions[num].provider as StartupProviderName,
            model: recentSessions[num].model,
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
      finish({ provider: providerOptions[providerIdx].descriptor.name });
    } else if (key.escape && recentRows > 0) {
      setScreen('recent');
    } else if (/^[0-9]$/.test(input)) {
      const num = Number.parseInt(input, 10);
      if (num < providerOptions.length) {
        finish({ provider: providerOptions[num].descriptor.name });
      }
    }
  });

  if (screen === 'recent') {
    return (
      <Box flexDirection="column">
        <Text bold>{'  Recent sessions:'}</Text>
        <Text> </Text>
        {recentSessions.map((s, i) => (
          <Row
            key={i}
            selected={i === recentIdx}
            shortcut={i.toString()}
            label={`${s.provider} / ${s.model}`}
            suffix={s.status ? STATUS_COLORS[s.status](`(${STATUS_LABELS[s.status]})`) : ''}
          />
        ))}
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
          shortcut={i < 10 ? i.toString() : ''}
          label={opt.descriptor.label}
        />
      ))}
      <Text> </Text>
      <Text dimColor>
        {`     ↑/↓ navigate · ↵ / space select · 0-9 jump · ${recentRows > 0 ? 'Esc back · ' : ''}Q exit`}
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

  let result: StartupSelection | null = null;
  const inkApp = render(
    <StartupMenuApp
      recentSessions={recentSessions}
      providerOptions={providerOptions}
      defaultProviderIndex={defaultProviderIndex}
      onResolve={(sel) => { result = sel; }}
    />,
  );
  await inkApp.waitUntilExit();
  inkApp.unmount();
  if (result === null) exitStartupSelection();
  return result;
}
