import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import chalk from 'chalk';

export interface RecentPair {
  provider: string;
  model: string;
}

type Stage =
  | { kind: 'recent' }
  | { kind: 'provider' }
  | { kind: 'loading'; provider: string }
  | { kind: 'model'; provider: string; models: string[] }
  | { kind: 'error'; provider: string; message: string };

export interface ProviderPickerProps {
  providers: string[];
  recents: RecentPair[];
  recentsLoading?: boolean;
  loadModels: (provider: string) => Promise<string[]>;
  initialProvider?: string;
  initialModel?: string;
  onCommit: (provider: string, model: string) => void;
  onCancel: () => void;
}

const VISIBLE_ROWS = 8;

export function ProviderPicker(props: ProviderPickerProps): React.ReactElement {
  const { providers, recents, recentsLoading, loadModels, initialProvider, initialModel, onCommit, onCancel } = props;

  // Always start in the recent stage. It degrades gracefully when recents
  // are still loading or empty (cursor lands on "Pick a different
  // provider"), which avoids a race where async-loaded recents arrive after
  // mount and silently strand the user in the provider list.
  const [stage, setStage] = useState<Stage>({ kind: 'recent' });
  const [recentIdx, setRecentIdx] = useState(0);
  const [providerIndex, setProviderIndex] = useState(
    Math.max(0, initialProvider ? providers.indexOf(initialProvider) : 0),
  );
  const [modelIndex, setModelIndex] = useState(0);

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
      // From loading/model/error, back up to the provider list.
      setStage({ kind: 'provider' });
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
      // `p` jumps to provider list — same shortcut as startup menu.
      if (input === 'p' || input === 'P') {
        setStage({ kind: 'provider' });
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
        const name = providers[providerIndex];
        if (!name) return;
        const preselect = name === initialProvider ? initialModel : undefined;
        void enterProvider(name, preselect);
        return;
      }
      return;
    }

    if (stage.kind === 'error') {
      // Any key (other than Esc, handled above) returns to the provider list.
      if (key.return || input) setStage({ kind: 'provider' });
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
  });

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="cyan">
      {renderBody()}
      <Text dimColor>↑/↓ navigate · Enter select · Esc {escLabel()}</Text>
    </Box>
  );

  function escLabel(): string {
    if (stage.kind === 'recent') return 'cancel';
    if (stage.kind === 'provider') return recents.length > 0 ? 'back' : 'cancel';
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
              const text = sel
                ? chalk.inverse(` ${p.provider} / ${p.model} `)
                : `  ${p.provider} / ${p.model}`;
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
          <Text color="cyan" bold>Pick a provider</Text>
          {renderList(providers, providerIndex)}
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
          <Text dimColor>Press Esc or any key to go back.</Text>
        </>
      );
    }
    return (
      <>
        <Text color="cyan" bold>{stage.provider} — pick a model</Text>
        {renderList(stage.models, modelIndex)}
      </>
    );
  }
}

function renderList(items: string[], selected: number): React.ReactElement {
  // Slide a fixed-height window over the list so a long model list (e.g.
  // OpenRouter) doesn't blow up vertical space.
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
        const text = isSel ? chalk.inverse(` ${item} `) : `  ${item}`;
        return <Text key={idx}>{text}</Text>;
      })}
      {end < items.length && <Text dimColor>  ↓ {items.length - end} more</Text>}
    </Box>
  );
}
