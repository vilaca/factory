import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import chalk from 'chalk';
import type { SessionErrorStatus } from '../../../core/session-log.js';
import { indexForShortcut, renderStatusBadge, shortcutFor } from './picker-shortcuts.js';

export interface RecentPair {
  provider: string;
  model: string;
  /** Optional badge (throttled/quota/permission/error). */
  status?: SessionErrorStatus;
}

export interface ProviderEntry {
  /** Canonical provider name (the key in PROVIDER_ALIASES values). */
  name: string;
  /** Display label, falls back to `name`. */
  label?: string;
  /** Dimmed + selection-blocked when true. */
  offline?: boolean;
}

/**
 * Optional per-model display info, used by both the startup picker (which
 * has access to the live Provider) and the mid-session picker (which only
 * knows model ids). When omitted, the picker just renders the model id.
 */
export interface ModelDisplayInfo {
  label?: string;
  warning?: string;
}

type Stage =
  | { kind: 'recent' }
  | { kind: 'provider' }
  | { kind: 'loading'; provider: string }
  | { kind: 'model'; provider: string; models: string[] }
  | { kind: 'error'; provider: string; message: string };

export interface ProviderPickerProps {
  /** Provider list. Use `name` only when no metadata is available. */
  providers: ProviderEntry[];
  recents: RecentPair[];
  recentsLoading?: boolean;
  /** Async loader; only invoked when entering the model stage from
   *  recent/provider. Not used when `startStage='model'` + `models` set. */
  loadModels: (provider: string) => Promise<string[]>;
  /** Optional per-row decorator for the model list. */
  getModelInfo?: (provider: string, model: string) => ModelDisplayInfo | undefined;
  initialProvider?: string;
  initialModel?: string;
  onCommit: (provider: string, model: string) => void;
  onCancel: () => void;
  /**
   * Skip-to-model mode. When set to `'model'`, the picker mounts directly
   * on the model stage with the `models` prop — the recent and provider
   * lists are unreachable. Esc cancels straight out. Default: `'recent'`.
   */
  startStage?: 'recent' | 'model';
  /** Pre-loaded model list. Required when `startStage === 'model'`. */
  models?: string[];
  /** When true (default), the picker is wrapped in a rounded border —
   *  matches the in-prompt panel style. Disable for full-screen startup
   *  rendering. */
  bordered?: boolean;
}

const VISIBLE_ROWS = 8;

export function ProviderPicker(props: ProviderPickerProps): React.ReactElement {
  const {
    providers, recents, recentsLoading, loadModels, getModelInfo,
    initialProvider, initialModel, onCommit, onCancel,
    startStage = 'recent', models: preloadedModels, bordered = true,
  } = props;

  const startsAtModel = startStage === 'model';
  const initialStage: Stage = startsAtModel
    ? {
        kind: 'model',
        provider: initialProvider ?? '',
        models: preloadedModels ?? [],
      }
    : { kind: 'recent' };

  const [stage, setStage] = useState<Stage>(initialStage);
  const [recentIdx, setRecentIdx] = useState(0);
  const [providerIndex, setProviderIndex] = useState(
    Math.max(0, initialProvider ? providers.findIndex(p => p.name === initialProvider) : 0),
  );
  const [modelIndex, setModelIndex] = useState(() => {
    if (startsAtModel && initialModel && preloadedModels) {
      const i = preloadedModels.indexOf(initialModel);
      return i >= 0 ? i : 0;
    }
    return 0;
  });

  async function enterProvider(name: string, preselectModel?: string): Promise<void> {
    setStage({ kind: 'loading', provider: name });
    try {
      const models = await loadModels(name);
      if (models.length === 0) {
        setStage({ kind: 'error', provider: name, message: 'no models returned' });
        return;
      }
      const idx = preselectModel ? Math.max(0, models.indexOf(preselectModel)) : 0;
      setModelIndex(idx);
      setStage({ kind: 'model', provider: name, models });
    } catch (err) {
      setStage({ kind: 'error', provider: name, message: (err as Error).message });
    }
  }

  function selectProviderEntry(entry: ProviderEntry): void {
    if (entry.offline) return;
    const preselect = entry.name === initialProvider ? initialModel : undefined;
    void enterProvider(entry.name, preselect);
  }

  useInput((input, key) => {
    if (key.escape) {
      if (stage.kind === 'recent') {
        onCancel();
        return;
      }
      if (stage.kind === 'provider') {
        if (recents.length > 0) setStage({ kind: 'recent' });
        else onCancel();
        return;
      }
      // From loading/model/error: back to provider list, unless we
      // started at model — then Esc cancels straight out.
      if (startsAtModel) onCancel();
      else setStage({ kind: 'provider' });
      return;
    }

    if (stage.kind === 'loading') return;

    if (stage.kind === 'recent') {
      // recents.length entries + 1 trailing "Pick a different provider" row.
      const lastIdx = recents.length;
      if (key.upArrow) {
        setRecentIdx((i) => (i - 1 + (lastIdx + 1)) % (lastIdx + 1));
        return;
      }
      if (key.downArrow) {
        setRecentIdx((i) => (i + 1) % (lastIdx + 1));
        return;
      }
      if (key.return) {
        if (recentIdx === lastIdx) {
          setStage({ kind: 'provider' });
          return;
        }
        const pair = recents[recentIdx];
        if (pair) onCommit(pair.provider, pair.model);
        return;
      }
      if (input === 'p' || input === 'P') {
        setStage({ kind: 'provider' });
        return;
      }
      // Number/letter shortcut: jump within the recent list. Treats
      // shortcuts beyond `recents.length - 1` as no-ops so `p` stays
      // routed above without colliding with letter shortcuts.
      const jump = indexForShortcut(input);
      if (jump >= 0 && jump < recents.length) {
        const pair = recents[jump];
        if (pair) onCommit(pair.provider, pair.model);
      }
      return;
    }

    if (stage.kind === 'provider') {
      if (key.upArrow) {
        setProviderIndex((i) => (i - 1 + providers.length) % providers.length);
        return;
      }
      if (key.downArrow) {
        setProviderIndex((i) => (i + 1) % providers.length);
        return;
      }
      if (key.return) {
        const entry = providers[providerIndex];
        if (entry) selectProviderEntry(entry);
        return;
      }
      const jump = indexForShortcut(input);
      if (jump >= 0 && jump < providers.length) {
        const entry = providers[jump];
        if (entry) selectProviderEntry(entry);
      }
      return;
    }

    if (stage.kind === 'error') {
      // Any key (other than Esc, handled above) returns to the provider
      // list — unless we started at model, in which case there's no
      // provider list to back into; keep the user on the error.
      if (key.return || input) {
        if (startsAtModel) onCancel();
        else setStage({ kind: 'provider' });
      }
      return;
    }

    // stage.kind === 'model'
    if (key.upArrow) {
      setModelIndex((i) => (i - 1 + stage.models.length) % stage.models.length);
      return;
    }
    if (key.downArrow) {
      setModelIndex((i) => (i + 1) % stage.models.length);
      return;
    }
    if (key.return) {
      const model = stage.models[modelIndex];
      if (model) onCommit(stage.provider, model);
      return;
    }
    const jump = indexForShortcut(input);
    if (jump >= 0 && jump < stage.models.length) {
      const model = stage.models[jump];
      if (model) onCommit(stage.provider, model);
    }
  });

  const body = renderBody();
  const footer = <Text dimColor>↑/↓ navigate · 0–9/A–Z jump · Enter select · Esc {escLabel()}</Text>;
  if (bordered) {
    return (
      <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="cyan">
        {body}
        {footer}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {body}
      <Text> </Text>
      {footer}
    </Box>
  );

  function escLabel(): string {
    if (stage.kind === 'recent') return 'cancel';
    if (stage.kind === 'provider') return recents.length > 0 ? 'back' : 'cancel';
    if (startsAtModel) return 'cancel';
    return 'back';
  }

  function renderBody(): React.ReactElement {
    if (stage.kind === 'recent') {
      const lastIdx = recents.length;
      const placeholder = recentsLoading
        ? 'Loading recent sessions…'
        : recents.length === 0
          ? '(no recent sessions yet)'
          : null;
      return (
        <>
          <Text color="cyan" bold>Recent provider/model</Text>
          <Box flexDirection="column">
            {recents.map((p, i) => {
              const sel = i === recentIdx;
              const sc = shortcutFor(i);
              const badge = p.status ? ` ${renderStatusBadge(p.status)}` : '';
              const labelText = `${sc ? `${sc}. ` : ''}${p.provider} / ${p.model}`;
              const text = sel
                ? chalk.inverse(` ${labelText} `) + badge
                : `  ${labelText}` + badge;
              return <Text key={`${p.provider}/${p.model}/${i}`}>{text}</Text>;
            })}
            {placeholder && <Text dimColor>{`  ${placeholder}`}</Text>}
            <Text dimColor>{'  ─'}</Text>
            {(() => {
              const sel = recentIdx === lastIdx;
              const label = ' Pick a different provider ';
              return <Text>{sel ? chalk.inverse(label) : `  ${label.trim()}`}</Text>;
            })()}
          </Box>
        </>
      );
    }
    if (stage.kind === 'provider') {
      return (
        <>
          <Text color="cyan" bold>Select a provider</Text>
          {renderProviderList(providers, providerIndex)}
        </>
      );
    }
    if (stage.kind === 'loading') {
      return (
        <>
          <Text color="cyan" bold>{stage.provider}</Text>
          <Text dimColor>Loading models…</Text>
        </>
      );
    }
    if (stage.kind === 'error') {
      return (
        <>
          <Text color="cyan" bold>{stage.provider}</Text>
          <Text color="red">⚠ {stage.message}</Text>
          <Text dimColor>{startsAtModel ? 'Press Esc to cancel.' : 'Press Esc or any key to go back.'}</Text>
        </>
      );
    }
    return (
      <>
        <Text color="cyan" bold>Select a model</Text>
        {renderModelList(stage.provider, stage.models, modelIndex)}
      </>
    );
  }

  function renderModelList(provider: string, items: string[], selected: number): React.ReactElement {
    const half = Math.floor(VISIBLE_ROWS / 2);
    let start = Math.max(0, selected - half);
    const end = Math.min(items.length, start + VISIBLE_ROWS);
    start = Math.max(0, end - VISIBLE_ROWS);
    const window = items.slice(start, end);
    return (
      <Box flexDirection="column">
        {start > 0 && <Text dimColor>  ↑ {start} more</Text>}
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
        {end < items.length && <Text dimColor>  ↓ {items.length - end} more</Text>}
      </Box>
    );
  }
}

function renderProviderList(items: ProviderEntry[], selected: number): React.ReactElement {
  const half = Math.floor(VISIBLE_ROWS / 2);
  let start = Math.max(0, selected - half);
  const end = Math.min(items.length, start + VISIBLE_ROWS);
  start = Math.max(0, end - VISIBLE_ROWS);
  const window = items.slice(start, end);
  return (
    <Box flexDirection="column">
      {start > 0 && <Text dimColor>  ↑ {start} more</Text>}
      {window.map((entry, i) => {
        const idx = start + i;
        const isSel = idx === selected;
        const sc = shortcutFor(idx);
        const display = entry.label ?? entry.name;
        const labelText = `${sc ? `${sc}. ` : ''}${display}`;
        const offlineSuffix = entry.offline ? ` ${chalk.dim('(offline)')}` : '';
        if (isSel) {
          // Inverse highlight; dim the whole row when offline so the user
          // sees it's blocked even with the cursor on it.
          const rendered = chalk.inverse(` ${labelText} `);
          return (
            <Text key={idx} dimColor={entry.offline}>{rendered}{offlineSuffix}</Text>
          );
        }
        return (
          <Text key={idx} dimColor={entry.offline}>{`  ${labelText}`}{offlineSuffix}</Text>
        );
      })}
      {end < items.length && <Text dimColor>  ↓ {items.length - end} more</Text>}
    </Box>
  );
}
