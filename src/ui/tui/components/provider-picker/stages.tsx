// Per-stage subviews for ProviderPicker. Each stage's render is a
// self-contained component that takes only the data it needs as props,
// so the orchestrator file can stay focused on state and keypress logic.

import React from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import {
  indexForShortcut as _indexForShortcut,
  renderStatusBadge,
  shortcutFor,
} from './shortcuts.js';
import { TextInput } from '../text-input.js';
import {
  type KeySummary,
  type ModelDisplayInfo,
  type ProviderEntry,
  type RecentPair,
  type Stage,
  VISIBLE_ROWS,
} from './types.js';

// Re-export so callers that only need keypress shortcut indexing don't
// have to import from picker-shortcuts directly. Keeps the import surface
// of the picker tidy.
export const indexForShortcut = _indexForShortcut;

function describeKeyRow(k: KeySummary): string {
  const base = k.label ? `${k.label} · …${k.fingerprint}` : `…${k.fingerprint}`;
  if (!k.stats || (k.stats.ok === 0 && k.stats.warn === 0)) return base;
  return `${base}  · ${k.stats.ok} ok / ${k.stats.warn} ⚠`;
}

function renderProviderList(items: ProviderEntry[], selected: number): React.ReactElement {
  const half = Math.floor(VISIBLE_ROWS / 2);
  let start = Math.max(0, selected - half);
  const end = Math.min(items.length, start + VISIBLE_ROWS);
  start = Math.max(0, end - VISIBLE_ROWS);
  const window = items.slice(start, end);
  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor> ↑ {start} more</Text>}
      {window.map((entry, i) => {
        const idx = start + i;
        const isSel = idx === selected;
        const sc = shortcutFor(idx);
        const display = entry.label ?? entry.name;
        const labelText = `${sc ? `${sc}. ` : ''}${display}`;
        const offlineSuffix = entry.offline ? ` ${chalk.dim('(offline)')}` : '';
        if (isSel) {
          const rendered = chalk.inverse(` ${labelText} `);
          return (
            <Text key={idx} dimColor={entry.offline}>
              {rendered}
              {offlineSuffix}
            </Text>
          );
        }
        return (
          <Text key={idx} dimColor={entry.offline}>
            {`  ${labelText}`}
            {offlineSuffix}
          </Text>
        );
      })}
      {end < items.length && <Text dimColor> ↓ {items.length - end} more</Text>}
    </Box>
  );
}

function renderModelList(
  provider: string,
  items: string[],
  selected: number,
  getModelInfo?: (provider: string, model: string) => ModelDisplayInfo | undefined,
): React.ReactElement {
  const half = Math.floor(VISIBLE_ROWS / 2);
  let start = Math.max(0, selected - half);
  const end = Math.min(items.length, start + VISIBLE_ROWS);
  start = Math.max(0, end - VISIBLE_ROWS);
  const window = items.slice(start, end);
  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor> ↑ {start} more</Text>}
      {window.map((item, i) => {
        const idx = start + i;
        const isSel = idx === selected;
        const info = getModelInfo?.(provider, item);
        const sc = shortcutFor(idx);
        const display = info?.label ?? item;
        const labelText = `${sc ? `${sc}. ` : ''}${display}`;
        const warning = info?.warning ? ` ${chalk.yellow(`(${info.warning})`)}` : '';
        const text = isSel ? chalk.inverse(` ${labelText} `) + warning : `  ${labelText}` + warning;
        return <Text key={idx}>{text}</Text>;
      })}
      {end < items.length && <Text dimColor> ↓ {items.length - end} more</Text>}
    </Box>
  );
}

interface RecentStageProps {
  recents: RecentPair[];
  recentsLoading?: boolean;
  recentIdx: number;
}

export function RecentStage({
  recents,
  recentsLoading,
  recentIdx,
}: RecentStageProps): React.ReactElement {
  const lastIdx = recents.length;
  const placeholder = recentsLoading
    ? 'Loading recent sessions…'
    : recents.length === 0
      ? '(no recent sessions yet)'
      : null;
  return (
    <>
      <Text color="cyan" bold>
        Recent provider/model
      </Text>
      <Box flexDirection="column">
        {recents.map((p, i) => {
          const sel = i === recentIdx;
          const sc = shortcutFor(i);
          const badge = p.status ? ` ${renderStatusBadge(p.status)}` : '';
          const labelText = `${sc ? `${sc}. ` : ''}${p.provider} / ${p.model}`;
          const text = sel ? chalk.inverse(` ${labelText} `) + badge : `  ${labelText}` + badge;
          return <Text key={`${p.provider}/${p.model}/${i}`}>{text}</Text>;
        })}
        {placeholder && <Text dimColor>{`  ${placeholder}`}</Text>}
        <Text dimColor>{'  ─'}</Text>
        {(() => {
          const sel = recentIdx === lastIdx;
          const label = ' Pick a different provider/model ';
          return <Text>{sel ? chalk.inverse(label) : `  ${label.trim()}`}</Text>;
        })()}
      </Box>
    </>
  );
}

interface ProviderStageProps {
  providers: ProviderEntry[];
  providerIndex: number;
}

export function ProviderStage({
  providers,
  providerIndex,
}: ProviderStageProps): React.ReactElement {
  return (
    <>
      <Text color="cyan" bold>
        Select a provider
      </Text>
      {renderProviderList(providers, providerIndex)}
    </>
  );
}

interface KeyStageProps {
  stage: Extract<Stage, { kind: 'key' }>;
  hasDelete: boolean;
}

export function KeyStage({ stage, hasDelete }: KeyStageProps): React.ReactElement {
  const n = stage.keys.length;
  return (
    <>
      <Text color="cyan" bold>
        {stage.provider} — select a key
      </Text>
      <Box flexDirection="column">
        {stage.keys.map((k, i) => {
          const sel = i === stage.selectedIdx;
          const sc = shortcutFor(i);
          const display = describeKeyRow(k);
          const labelText = `${sc ? `${sc}. ` : ''}${display}`;
          const text = sel ? chalk.inverse(` ${labelText} `) : `  ${labelText}`;
          return <Text key={k.id}>{text}</Text>;
        })}
        {(() => {
          const i = n;
          const sel = i === stage.selectedIdx;
          const labelText = ' Add new key… ';
          return <Text key="add">{sel ? chalk.inverse(labelText) : `  ${labelText.trim()}`}</Text>;
        })()}
        {hasDelete &&
          (() => {
            const i = n + 1;
            const sel = i === stage.selectedIdx;
            const labelText = ' Delete a key… ';
            return (
              <Text key="del">{sel ? chalk.inverse(labelText) : `  ${labelText.trim()}`}</Text>
            );
          })()}
      </Box>
    </>
  );
}

interface KeyDeleteStageProps {
  stage: Extract<Stage, { kind: 'key-delete' }>;
}

export function KeyDeleteStage({ stage }: KeyDeleteStageProps): React.ReactElement {
  return (
    <>
      <Text color="cyan" bold>
        {stage.provider} — pick a key to delete
      </Text>
      <Box flexDirection="column">
        {stage.keys.map((k, i) => {
          const sel = i === stage.selectedIdx;
          const display = describeKeyRow(k);
          const text = sel ? chalk.inverse(` ${display} `) : `  ${display}`;
          return <Text key={k.id}>{text}</Text>;
        })}
      </Box>
    </>
  );
}

interface ConfirmDeleteStageProps {
  stage: Extract<Stage, { kind: 'key-confirm-delete' }>;
}

export function ConfirmDeleteStage({ stage }: ConfirmDeleteStageProps): React.ReactElement {
  const target = stage.keys[stage.selectedIdx];
  return (
    <>
      <Text color="red" bold>
        Delete this key?
      </Text>
      <Text>{target ? `  ${describeKeyRow(target)}` : '  (gone)'}</Text>
    </>
  );
}

interface KeyAddStageProps {
  stage: Extract<Stage, { kind: 'key-add' }>;
  onChange: (next: string) => void;
  onSubmit: (value: string) => void;
}

export function KeyAddStage({ stage, onChange, onSubmit }: KeyAddStageProps): React.ReactElement {
  return (
    <>
      <Text color="cyan" bold>
        {stage.provider} — paste API token
      </Text>
      <Box>
        <Text dimColor> token: </Text>
        <TextInput value={stage.tokenDraft} onChange={onChange} onSubmit={onSubmit} />
      </Box>
      <Text dimColor> the token will be hidden after validation</Text>
    </>
  );
}

interface ValidatingStageProps {
  stage: Extract<Stage, { kind: 'key-validating' }>;
}

export function ValidatingStage({ stage }: ValidatingStageProps): React.ReactElement {
  return (
    <>
      <Text color="cyan" bold>
        {stage.provider}
      </Text>
      <Text dimColor>Validating key… (3s timeout)</Text>
    </>
  );
}

interface ValidateFailedStageProps {
  stage: Extract<Stage, { kind: 'key-validate-failed' }>;
}

export function ValidateFailedStage({ stage }: ValidateFailedStageProps): React.ReactElement {
  const opts = [' edit ', ' save anyway '];
  return (
    <>
      <Text color="cyan" bold>
        {stage.provider} — validation failed
      </Text>
      <Text color="red">⚠ {stage.error}</Text>
      <Box flexDirection="column">
        {opts.map((o, i) => {
          const sel = i === stage.choice;
          return <Text key={i}>{sel ? chalk.inverse(o) : `  ${o.trim()}`}</Text>;
        })}
      </Box>
    </>
  );
}

interface LoadingStageProps {
  stage: Extract<Stage, { kind: 'loading' }>;
}

export function LoadingStage({ stage }: LoadingStageProps): React.ReactElement {
  return (
    <>
      <Text color="cyan" bold>
        {stage.provider}
      </Text>
      <Text dimColor>Loading models…</Text>
    </>
  );
}

interface ErrorStageProps {
  stage: Extract<Stage, { kind: 'error' }>;
  startsAtModel: boolean;
}

export function ErrorStage({ stage, startsAtModel }: ErrorStageProps): React.ReactElement {
  return (
    <>
      <Text color="cyan" bold>
        {stage.provider}
      </Text>
      <Text color="red">⚠ {stage.message}</Text>
      <Text dimColor>
        {startsAtModel ? 'Press Esc to cancel.' : 'Press Esc or any key to go back.'}
      </Text>
    </>
  );
}

interface ModelStageProps {
  stage: Extract<Stage, { kind: 'model' }>;
  modelIndex: number;
  getModelInfo?: (provider: string, model: string) => ModelDisplayInfo | undefined;
}

export function ModelStage({
  stage,
  modelIndex,
  getModelInfo,
}: ModelStageProps): React.ReactElement {
  return (
    <>
      <Text color="cyan" bold>
        Select a model
      </Text>
      {renderModelList(stage.provider, stage.models, modelIndex, getModelInfo)}
    </>
  );
}
