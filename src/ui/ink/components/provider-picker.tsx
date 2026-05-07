import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import chalk from 'chalk';
import type { SessionErrorStatus } from '../../../core/session-log.js';
import { indexForShortcut, renderStatusBadge, shortcutFor } from './picker-shortcuts.js';
import { TextInput } from './text-input.js';

export interface RecentPair {
  provider: string;
  model: string;
  /** Optional badge (throttled/quota/permission/error). */
  status?: SessionErrorStatus;
  /** Set when this recent pair was tied to a specific saved key. */
  keyId?: string;
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
interface ModelDisplayInfo {
  label?: string;
  warning?: string;
}

/** Subset of ProviderKey shown to the picker — token never crosses this surface. */
interface KeySummary {
  id: string;
  label?: string;
  /** Last-4 fingerprint of the saved token. */
  fingerprint: string;
  /** Optional usage counters for the picker's compact stat column. */
  stats?: { ok: number; warn: number };
}

interface ValidateResult {
  ok: boolean;
  /** Model ids returned by listModels, on success. */
  models?: string[];
  /** Error message, on failure. */
  error?: string;
}

type Stage =
  | { kind: 'recent' }
  | { kind: 'provider' }
  | { kind: 'key'; provider: string; keys: KeySummary[]; selectedIdx: number }
  | { kind: 'key-delete'; provider: string; keys: KeySummary[]; selectedIdx: number }
  | { kind: 'key-confirm-delete'; provider: string; keys: KeySummary[]; selectedIdx: number }
  | { kind: 'key-add'; provider: string; tokenDraft: string }
  | { kind: 'key-validating'; provider: string; token: string }
  | { kind: 'key-validate-failed'; provider: string; token: string; error: string; choice: 0 | 1 }
  | { kind: 'loading'; provider: string; keyId?: string }
  | { kind: 'model'; provider: string; models: string[]; keyId?: string }
  | { kind: 'error'; provider: string; message: string };

interface ProviderPickerProps {
  /** Provider list. Use `name` only when no metadata is available. */
  providers: ProviderEntry[];
  recents: RecentPair[];
  recentsLoading?: boolean;
  /** Async loader; only invoked when entering the model stage from
   *  recent/provider. Not used when `startStage='model'` + `models` set. */
  loadModels: (provider: string, keyId?: string) => Promise<string[]>;
  /** Optional per-row decorator for the model list. */
  getModelInfo?: (provider: string, model: string) => ModelDisplayInfo | undefined;
  /** When provided, the picker shows the key stage between provider and
   *  model selection. Returning an empty list lands directly on key-add. */
  loadKeysForProvider?: (provider: string) => Promise<KeySummary[]>;
  /** Called when the user submits a token in key-add. Resolves to either
   *  `{ok, models}` (validation succeeded) or `{ok: false, error}`. */
  validateKey?: (provider: string, token: string) => Promise<ValidateResult>;
  /** Persists a validated (or override-saved) token. Returns the new key id. */
  saveKey?: (provider: string, token: string) => Promise<string>;
  /** Deletes a saved key by id. */
  deleteKey?: (provider: string, keyId: string) => Promise<void>;
  /** Provider names that should drive key + model selection inside the
   *  picker. Other providers short-circuit to model loading without
   *  showing a key stage. */
  multiKeyProviders?: ReadonlySet<string>;
  initialProvider?: string;
  initialModel?: string;
  initialKeyId?: string;
  onCommit: (provider: string, model: string, keyId?: string) => void;
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
  /**
   * Picker purpose. Default `'select-active'` — selecting a key + model
   * commits both to the active session via onCommit(provider, model, keyId).
   *
   * `'select-rotation-entry'` skips the key stage entirely (rotation chain
   * entries are just `(provider, model)`), and the heading text shifts so
   * the user knows they're shaping a fallback list, not switching the
   * active selection. Always commits with keyId=undefined.
   */
  purpose?: 'select-active' | 'select-rotation-entry';
}

const VISIBLE_ROWS = 8;

export function ProviderPicker(props: ProviderPickerProps): React.ReactElement {
  const {
    providers,
    recents,
    recentsLoading,
    loadModels,
    getModelInfo,
    loadKeysForProvider,
    validateKey,
    saveKey,
    deleteKey,
    multiKeyProviders,
    initialProvider,
    initialModel,
    initialKeyId,
    onCommit,
    onCancel,
    startStage = 'recent',
    models: preloadedModels,
    bordered = true,
    purpose = 'select-active',
  } = props;
  const isFallbackPicker = purpose === 'select-rotation-entry';

  const startsAtModel = startStage === 'model';
  const initialStage: Stage = startsAtModel
    ? {
        kind: 'model',
        provider: initialProvider ?? '',
        models: preloadedModels ?? [],
        ...(initialKeyId ? { keyId: initialKeyId } : {}),
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

  function isMultiKey(name: string): boolean {
    // Fallback-picker mode never enters the key stage — rotation entries
    // are just `(provider, model)` pairs, not key bindings.
    if (isFallbackPicker) return false;
    return Boolean(loadKeysForProvider && multiKeyProviders?.has(name));
  }

  async function enterProvider(name: string, preselectModel?: string): Promise<void> {
    if (isMultiKey(name) && loadKeysForProvider) {
      try {
        const keys = await loadKeysForProvider(name);
        if (keys.length === 0) {
          // No saved keys — drop straight into key-add.
          setStage({ kind: 'key-add', provider: name, tokenDraft: '' });
          return;
        }
        // Pre-select the matching keyId from initialKeyId when this is the
        // current provider, otherwise fall back to the first entry.
        const idx =
          name === initialProvider && initialKeyId
            ? Math.max(
                0,
                keys.findIndex(k => k.id === initialKeyId),
              )
            : 0;
        setStage({ kind: 'key', provider: name, keys, selectedIdx: idx });
        return;
      } catch (err) {
        setStage({ kind: 'error', provider: name, message: (err as Error).message });
        return;
      }
    }
    await loadAndShowModels(name, undefined, preselectModel);
  }

  async function loadAndShowModels(
    name: string,
    keyId: string | undefined,
    preselectModel: string | undefined,
  ): Promise<void> {
    setStage({ kind: 'loading', provider: name, ...(keyId ? { keyId } : {}) });
    try {
      const models = await loadModels(name, keyId);
      if (models.length === 0) {
        setStage({ kind: 'error', provider: name, message: 'no models returned' });
        return;
      }
      const idx = preselectModel ? Math.max(0, models.indexOf(preselectModel)) : 0;
      setModelIndex(idx);
      setStage({ kind: 'model', provider: name, models, ...(keyId ? { keyId } : {}) });
    } catch (err) {
      setStage({ kind: 'error', provider: name, message: (err as Error).message });
    }
  }

  function selectProviderEntry(entry: ProviderEntry): void {
    if (entry.offline) return;
    const preselect = entry.name === initialProvider ? initialModel : undefined;
    void enterProvider(entry.name, preselect);
  }

  // Drive the validation step. Run as a side effect when stage flips into
  // `key-validating` so the actual user input → API call latency happens
  // outside the synchronous Enter handler. Race against a 3 s timeout —
  // no point making the user stare at "Validating…" if the provider is
  // unreachable; they can choose "save anyway" if they want to persist
  // without confirmation.
  const validatingToken = stage.kind === 'key-validating' ? stage.token : null;
  const validatingProvider = stage.kind === 'key-validating' ? stage.provider : null;
  useEffect(() => {
    if (!validatingToken || !validatingProvider) return;
    if (!validateKey || !saveKey) return;
    let cancelled = false;
    const VALIDATE_TIMEOUT_MS = 3000;
    const timeout = new Promise<ValidateResult>(resolve => {
      setTimeout(
        () =>
          resolve({
            ok: false,
            error: `validation timed out after ${VALIDATE_TIMEOUT_MS / 1000}s`,
          }),
        VALIDATE_TIMEOUT_MS,
      );
    });
    void Promise.race([validateKey(validatingProvider, validatingToken), timeout]).then(
      async result => {
        if (cancelled) return;
        if (result.ok) {
          try {
            const newKeyId = await saveKey(validatingProvider, validatingToken);
            const models = result.models ?? [];
            if (models.length === 0) {
              setStage({
                kind: 'error',
                provider: validatingProvider,
                message: 'no models returned',
              });
              return;
            }
            setModelIndex(0);
            setStage({ kind: 'model', provider: validatingProvider, models, keyId: newKeyId });
          } catch (err) {
            setStage({
              kind: 'key-validate-failed',
              provider: validatingProvider,
              token: validatingToken,
              error: (err as Error).message,
              choice: 0,
            });
          }
        } else {
          setStage({
            kind: 'key-validate-failed',
            provider: validatingProvider,
            token: validatingToken,
            error: result.error ?? 'unknown error',
            choice: 0,
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [validatingToken, validatingProvider, validateKey, saveKey]);

  const isTextInputStage = stage.kind === 'key-add';

  useInput(
    (input, key) => {
      if (key.escape) {
        switch (stage.kind) {
          case 'recent':
            onCancel();
            return;
          case 'provider':
            if (recents.length > 0) setStage({ kind: 'recent' });
            else onCancel();
            return;
          case 'key':
            setStage({ kind: 'provider' });
            return;
          case 'key-delete':
            setStage({
              kind: 'key',
              provider: stage.provider,
              keys: stage.keys,
              selectedIdx: stage.selectedIdx,
            });
            return;
          case 'key-confirm-delete':
            setStage({
              kind: 'key-delete',
              provider: stage.provider,
              keys: stage.keys,
              selectedIdx: stage.selectedIdx,
            });
            return;
          case 'key-add':
            // Back to key-list (refresh in case the user had added other keys).
            if (loadKeysForProvider) {
              void loadKeysForProvider(stage.provider).then(keys => {
                if (keys.length === 0) onCancel();
                else setStage({ kind: 'key', provider: stage.provider, keys, selectedIdx: 0 });
              });
            } else {
              setStage({ kind: 'provider' });
            }
            return;
          case 'key-validating':
            // Treat as cancel — fall back to the typed token in case the user
            // wants to retry without retyping.
            setStage({ kind: 'key-add', provider: stage.provider, tokenDraft: stage.token });
            return;
          case 'key-validate-failed':
            setStage({ kind: 'key-add', provider: stage.provider, tokenDraft: stage.token });
            return;
          case 'loading':
          case 'model':
          case 'error':
            if (startsAtModel) onCancel();
            else setStage({ kind: 'provider' });
            return;
        }
      }

      if (isTextInputStage) {
        // TextInput owns input on key-add. Picker only listens for Esc above.
        return;
      }

      if (stage.kind === 'loading' || stage.kind === 'key-validating') return;

      if (stage.kind === 'recent') {
        const lastIdx = recents.length;
        if (key.upArrow) {
          setRecentIdx(i => (i - 1 + (lastIdx + 1)) % (lastIdx + 1));
          return;
        }
        if (key.downArrow) {
          setRecentIdx(i => (i + 1) % (lastIdx + 1));
          return;
        }
        if (key.return) {
          if (recentIdx === lastIdx) {
            setStage({ kind: 'provider' });
            return;
          }
          const pair = recents[recentIdx];
          if (pair) onCommit(pair.provider, pair.model, pair.keyId);
          return;
        }
        if (input === 'p' || input === 'P') {
          setStage({ kind: 'provider' });
          return;
        }
        const jump = indexForShortcut(input);
        if (jump >= 0 && jump < recents.length) {
          const pair = recents[jump];
          if (pair) onCommit(pair.provider, pair.model, pair.keyId);
        }
        return;
      }

      if (stage.kind === 'provider') {
        if (key.upArrow) {
          setProviderIndex(i => (i - 1 + providers.length) % providers.length);
          return;
        }
        if (key.downArrow) {
          setProviderIndex(i => (i + 1) % providers.length);
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

      if (stage.kind === 'key') {
        // rows[0..n-1]: keys; rows[n]: Add new key…; rows[n+1] (if n>=1): Delete a key…
        const n = stage.keys.length;
        const hasDelete = n >= 1 && Boolean(deleteKey);
        const total = n + 1 + (hasDelete ? 1 : 0);
        if (key.upArrow) {
          setStage({ ...stage, selectedIdx: (stage.selectedIdx - 1 + total) % total });
          return;
        }
        if (key.downArrow) {
          setStage({ ...stage, selectedIdx: (stage.selectedIdx + 1) % total });
          return;
        }
        if (key.return) {
          if (stage.selectedIdx === n) {
            setStage({ kind: 'key-add', provider: stage.provider, tokenDraft: '' });
            return;
          }
          if (hasDelete && stage.selectedIdx === n + 1) {
            setStage({
              kind: 'key-delete',
              provider: stage.provider,
              keys: stage.keys,
              selectedIdx: 0,
            });
            return;
          }
          const chosen = stage.keys[stage.selectedIdx];
          if (chosen) {
            void loadAndShowModels(stage.provider, chosen.id, undefined);
          }
          return;
        }
        const jump = indexForShortcut(input);
        if (jump >= 0 && jump < n) {
          const chosen = stage.keys[jump];
          if (chosen) void loadAndShowModels(stage.provider, chosen.id, undefined);
        }
        return;
      }

      if (stage.kind === 'key-delete') {
        const n = stage.keys.length;
        if (n === 0) {
          setStage({ kind: 'key', provider: stage.provider, keys: [], selectedIdx: 0 });
          return;
        }
        if (key.upArrow) {
          setStage({ ...stage, selectedIdx: (stage.selectedIdx - 1 + n) % n });
          return;
        }
        if (key.downArrow) {
          setStage({ ...stage, selectedIdx: (stage.selectedIdx + 1) % n });
          return;
        }
        if (key.return) {
          setStage({
            kind: 'key-confirm-delete',
            provider: stage.provider,
            keys: stage.keys,
            selectedIdx: stage.selectedIdx,
          });
        }
        return;
      }

      if (stage.kind === 'key-confirm-delete') {
        if (key.return || input === 'y' || input === 'Y') {
          const target = stage.keys[stage.selectedIdx];
          const provider = stage.provider;
          if (!target || !deleteKey || !loadKeysForProvider) {
            setStage({ kind: 'key', provider, keys: stage.keys, selectedIdx: stage.selectedIdx });
            return;
          }
          void deleteKey(provider, target.id)
            .then(() => loadKeysForProvider(provider))
            .then(keys => {
              if (keys.length === 0) {
                // After deleting the last key, drop into add — the user clearly
                // wants to manage credentials right now.
                setStage({ kind: 'key-add', provider, tokenDraft: '' });
              } else {
                setStage({
                  kind: 'key',
                  provider,
                  keys,
                  selectedIdx: Math.min(stage.selectedIdx, keys.length - 1),
                });
              }
            });
          return;
        }
        if (input === 'n' || input === 'N') {
          setStage({
            kind: 'key-delete',
            provider: stage.provider,
            keys: stage.keys,
            selectedIdx: stage.selectedIdx,
          });
        }
        return;
      }

      if (stage.kind === 'key-validate-failed') {
        if (key.upArrow) {
          setStage({ ...stage, choice: stage.choice === 0 ? 1 : 0 });
          return;
        }
        if (key.downArrow) {
          setStage({ ...stage, choice: stage.choice === 0 ? 1 : 0 });
          return;
        }
        if (key.return) {
          if (stage.choice === 0) {
            // edit
            setStage({ kind: 'key-add', provider: stage.provider, tokenDraft: stage.token });
          } else {
            // save anyway → persist + go to loading
            if (saveKey) {
              const provider = stage.provider;
              const token = stage.token;
              void saveKey(provider, token).then(newKeyId => {
                void loadAndShowModels(provider, newKeyId, undefined);
              });
            }
          }
        }
        return;
      }

      if (stage.kind === 'error') {
        if (key.return || input) {
          if (startsAtModel) onCancel();
          else setStage({ kind: 'provider' });
        }
        return;
      }

      // stage.kind === 'model'
      if (key.upArrow) {
        setModelIndex(i => (i - 1 + stage.models.length) % stage.models.length);
        return;
      }
      if (key.downArrow) {
        setModelIndex(i => (i + 1) % stage.models.length);
        return;
      }
      if (key.return) {
        const model = stage.models[modelIndex];
        if (model) onCommit(stage.provider, model, stage.keyId);
        return;
      }
      const jump = indexForShortcut(input);
      if (jump >= 0 && jump < stage.models.length) {
        const model = stage.models[jump];
        if (model) onCommit(stage.provider, model, stage.keyId);
      }
    },
    { isActive: true },
  );

  const body = renderBody();
  const footer = <Text dimColor>{footerText()}</Text>;
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

  function footerText(): string {
    if (stage.kind === 'key-add') return 'type/paste token · Enter validate · Esc back';
    if (stage.kind === 'key-validating') return 'validating…';
    if (stage.kind === 'key-validate-failed')
      return '↑/↓ choose · Enter confirm · Esc back to edit';
    if (stage.kind === 'key-confirm-delete') return 'y/Enter confirm · n/Esc cancel';
    return `↑/↓ navigate · 0–9/A–Z jump · Enter select · Esc ${escLabel()}`;
  }

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
    if (stage.kind === 'provider') {
      return (
        <>
          <Text color="cyan" bold>
            Select a provider
          </Text>
          {renderProviderList(providers, providerIndex)}
        </>
      );
    }
    if (stage.kind === 'key') {
      const n = stage.keys.length;
      const hasDelete = n >= 1 && Boolean(deleteKey);
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
              return (
                <Text key="add">{sel ? chalk.inverse(labelText) : `  ${labelText.trim()}`}</Text>
              );
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
    if (stage.kind === 'key-delete') {
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
    if (stage.kind === 'key-confirm-delete') {
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
    if (stage.kind === 'key-add') {
      return (
        <>
          <Text color="cyan" bold>
            {stage.provider} — paste API token
          </Text>
          <Box>
            <Text dimColor> token: </Text>
            <TextInput
              value={stage.tokenDraft}
              onChange={next => setStage({ ...stage, tokenDraft: next })}
              onSubmit={value => {
                const trimmed = value.trim();
                if (!trimmed) return;
                setStage({ kind: 'key-validating', provider: stage.provider, token: trimmed });
              }}
            />
          </Box>
          <Text dimColor> the token will be hidden after validation</Text>
        </>
      );
    }
    if (stage.kind === 'key-validating') {
      return (
        <>
          <Text color="cyan" bold>
            {stage.provider}
          </Text>
          <Text dimColor>Validating key… (3s timeout)</Text>
        </>
      );
    }
    if (stage.kind === 'key-validate-failed') {
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
    if (stage.kind === 'loading') {
      return (
        <>
          <Text color="cyan" bold>
            {stage.provider}
          </Text>
          <Text dimColor>Loading models…</Text>
        </>
      );
    }
    if (stage.kind === 'error') {
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
    return (
      <>
        <Text color="cyan" bold>
          Select a model
        </Text>
        {renderModelList(stage.provider, stage.models, modelIndex)}
      </>
    );
  }

  function renderModelList(
    provider: string,
    items: string[],
    selected: number,
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
          const text = isSel
            ? chalk.inverse(` ${labelText} `) + warning
            : `  ${labelText}` + warning;
          return <Text key={idx}>{text}</Text>;
        })}
        {end < items.length && <Text dimColor> ↓ {items.length - end} more</Text>}
      </Box>
    );
  }
}

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
