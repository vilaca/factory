import React from 'react';
import os from 'os';
import { Box, Text } from 'ink';

interface StatusBarProps {
  planMode: boolean;
  state: 'idle' | 'running' | 'awaiting-permission';
  /** Transient label rendered in place of "running" while the agent is
   *  doing something specific (retry/backoff sleep, rotation hand-off,
   *  shutdown). Cleared by the event handler at progress events. When
   *  null/undefined, the bar shows the literal "running". */
  activity?: string | null;
  providerName: string;
  model: string;
  totalTokens?: number;
  /** When true, the totalTokens figure is an estimate, not a model-reported
   * count — render it with a leading `~` so the user can tell. */
  tokensAreEstimate?: boolean;
  contextWindow: number;
  sessionTurns: number;
  sessionToolCalls: number;
  queueLength: number;
  gitBranch?: string;
  gitDirty?: boolean | null;
  /** Per-tab working directory. Shown as basename only — full path would
   * crowd the bar; users can run /cwd to see the full path. */
  cwd?: string;
}

function shortenCwd(cwd: string): string {
  const home = os.homedir();
  if (home && cwd === home) return '~';
  if (home && cwd.startsWith(home + '/'))
    return (
      '~/' +
      cwd
        .slice(home.length + 1)
        .split('/')
        .slice(-1)[0]
    );
  return cwd.split('/').filter(Boolean).slice(-1)[0] ?? cwd;
}

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const {
    planMode,
    state,
    activity,
    providerName,
    model,
    totalTokens,
    tokensAreEstimate,
    contextWindow,
    sessionTurns,
    sessionToolCalls,
    queueLength,
    gitBranch,
    gitDirty,
    cwd,
  } = props;
  const tokenPct =
    totalTokens && contextWindow ? Math.round((totalTokens / contextWindow) * 100) : undefined;
  const suffix = tokensAreEstimate ? ' (est.)' : '';

  return (
    <Box paddingX={1}>
      <Text dimColor>
        {planMode ? (
          <Text color="cyan" bold>
            PLAN ·{' '}
          </Text>
        ) : (
          ''
        )}
        {state === 'awaiting-permission' ? (
          <Text color="yellow" bold>
            PERMISSION ·{' '}
          </Text>
        ) : (
          ''
        )}
        {state === 'running' ? (
          activity ? (
            // Activity replaces the literal "running" so the user sees what
            // the agent is doing right now (retrying / rotating / etc.) —
            // yellow signals "paused but not stuck".
            <Text color="yellow">{activity} · </Text>
          ) : (
            <Text color="green">running · </Text>
          )
        ) : (
          ''
        )}
        {`${providerName}/${model}`}
        {cwd && (
          <>
            {' · '}
            <Text color="blue">{shortenCwd(cwd)}</Text>
          </>
        )}
        {gitBranch && (
          <>
            {' · '}
            <Text color="cyan">{gitBranch}</Text>
            {gitDirty && <Text color="yellow">*</Text>}
          </>
        )}
        {tokenPct !== undefined
          ? ` · ${totalTokens!.toLocaleString()}/${contextWindow.toLocaleString()} (${tokenPct}%)${suffix}`
          : ''}
        {sessionTurns > 0 ? ` · ${sessionTurns} ${sessionTurns === 1 ? 'turn' : 'turns'}` : ''}
        {sessionToolCalls > 0
          ? ` · ${sessionToolCalls} ${sessionToolCalls === 1 ? 'tool' : 'tools'}`
          : ''}
        {queueLength > 0 ? ` · 📨 ${queueLength} queued` : ''}
      </Text>
    </Box>
  );
}
