import { useInput } from 'ink';
import { type KeySummary, type ProviderEntry, type RecentPair, type Stage } from './types.js';
import { indexForShortcut } from './stages.js';

interface UseProviderPickerKeysArgs {
  stage: Stage;
  setStage: (s: Stage) => void;
  recentIdx: number;
  setRecentIdx: (updater: (i: number) => number) => void;
  providerIndex: number;
  setProviderIndex: (updater: (i: number) => number) => void;
  modelIndex: number;
  setModelIndex: (idx: number | ((i: number) => number)) => void;
  recents: RecentPair[];
  providers: ProviderEntry[];
  loadModels: (provider: string, keyId?: string) => Promise<string[]>;
  loadKeysForProvider?: (provider: string) => Promise<KeySummary[]>;
  saveKey?: (provider: string, token: string) => Promise<string>;
  deleteKey?: (provider: string, keyId: string) => Promise<void>;
  multiKeyProviders?: ReadonlySet<string>;
  initialProvider?: string;
  initialKeyId?: string;
  initialModel?: string;
  isFallbackPicker: boolean;
  startsAtModel: boolean;
  onCommit: (provider: string, model: string, keyId?: string) => void;
  onCancel: () => void;
}

/**
 * Owns the per-stage keyboard dispatch + Esc routing for ProviderPicker.
 * Extracted from the main component so the picker file stays focused on
 * stage state, validation effect, and rendering.
 *
 * Internal stage-transition helpers (isMultiKey, enterProvider,
 * loadAndShowModels, selectProviderEntry) live with the dispatch since
 * they have no callers outside the keyboard handler.
 */
// eslint-disable-next-line max-lines-per-function -- TODO(complexity): split per-stage key handlers (Esc switch + per-stage keypress dispatch).
export function useProviderPickerKeys(args: UseProviderPickerKeysArgs): void {
  const {
    stage,
    setStage,
    recentIdx,
    setRecentIdx,
    providerIndex,
    setProviderIndex,
    modelIndex,
    setModelIndex,
    recents,
    providers,
    loadModels,
    loadKeysForProvider,
    saveKey,
    deleteKey,
    multiKeyProviders,
    initialProvider,
    initialKeyId,
    initialModel,
    isFallbackPicker,
    startsAtModel,
    onCommit,
    onCancel,
  } = args;

  function isMultiKey(name: string): boolean {
    // Fallback-picker mode never enters the key stage — rotation entries
    // are just `(provider, model)` pairs, not key bindings.
    if (isFallbackPicker) return false;
    return Boolean(loadKeysForProvider && multiKeyProviders?.has(name));
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

  function selectProviderEntry(entry: ProviderEntry): void {
    if (entry.offline) return;
    const preselect = entry.name === initialProvider ? initialModel : undefined;
    void enterProvider(entry.name, preselect);
  }

  const isTextInputStage = stage.kind === 'key-add';

  useInput(
    // eslint-disable-next-line max-statements, sonarjs/cognitive-complexity, complexity -- TODO(complexity): split per-stage key handlers.
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
}
