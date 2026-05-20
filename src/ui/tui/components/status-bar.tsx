import React from 'react';
import os from 'os';
import { Box, Text } from 'ink';

const HOME_DIR = os.homedir();

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
  /** Tokens in the *current* prompt (everything the next turn would send:
   *  system prompt + running conversation since the last compaction). This
   *  is what gets compared against `contextWindow` to answer "how much room
   *  is left until compaction is needed?". Excludes completion tokens — they
   *  go into the message history as a (usually small) assistant message, not
   *  back into the prompt verbatim. */
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

/** Render the "ctx N/M (P%)" segment. Pure so unit tests can pin the
 *  prompt-tokens vs total-tokens semantics (fix 44aeb26) and the <1%
 *  formatting without touching Ink. Returns the empty string when there's
 *  nothing meaningful to render (no token count, or zero/missing window). */
export function formatTokenSegment(
  totalTokens: number | undefined,
  contextWindow: number,
  tokensAreEstimate: boolean,
): string {
  if (!totalTokens || !contextWindow) return '';
  // Render percentage with one decimal place when it would otherwise round to
  // 0% (i.e. <1% used) — a fresh session on a 200k-window model can sit at
  // 0.3% for a long time, and a flat "0%" reads as broken. Above 1% we keep
  // the integer form so the bar stays compact.
  const rawPct = (totalTokens / contextWindow) * 100;
  const tokenPct = rawPct < 1 ? rawPct.toFixed(1) : Math.round(rawPct).toString();
  const suffix = tokensAreEstimate ? ' (est.)' : '';
  return ` · ctx ${totalTokens.toLocaleString()}/${contextWindow.toLocaleString()} (${tokenPct}%)${suffix}`;
}

/** Choose which token figure feeds the status bar. The model-reported
 *  `promptTokens` is the right metric — it's "how full is the next prompt",
 *  i.e. system prompt + running conversation since the last compaction.
 *  `totalTokens` (= prompt + completion) caused the figure to jitter down
 *  whenever the model gave a long reply, since completion tokens fold into
 *  the next prompt as a (usually small) assistant message rather than
 *  reappearing verbatim (see fix 44aeb26). The local `estimatedTokens` is
 *  the pre-first-response fallback. Returns the count + whether it should
 *  be marked as an estimate in the UI. */
export function selectDisplayTokens(
  lastUsage: { promptTokens?: number } | undefined,
  estimatedTokens: number | undefined,
): { totalTokens: number | undefined; tokensAreEstimate: boolean } {
  return {
    totalTokens: lastUsage?.promptTokens ?? estimatedTokens,
    tokensAreEstimate: lastUsage?.promptTokens === undefined && estimatedTokens !== undefined,
  };
}

function shortenCwd(cwd: string): string {
  const home = HOME_DIR;
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
  const tokenSegment = formatTokenSegment(totalTokens, contextWindow, !!tokensAreEstimate);

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
        {tokenSegment}
        {sessionTurns > 0 ? ` · ${sessionTurns} ${sessionTurns === 1 ? 'turn' : 'turns'}` : ''}
        {sessionToolCalls > 0
          ? ` · ${sessionToolCalls} ${sessionToolCalls === 1 ? 'tool' : 'tools'}`
          : ''}
        {queueLength > 0 ? ` · 📨 ${queueLength} queued` : ''}
      </Text>
    </Box>
  );
}
