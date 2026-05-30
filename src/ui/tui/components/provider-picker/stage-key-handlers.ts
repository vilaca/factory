import { indexForShortcut } from './stages.js';
import type { ProviderEntry, RecentPair, Stage, KeySummary } from './types.js';

interface PickerKey {
  escape?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
}

interface StageHandlerDeps {
  recents: RecentPair[];
  providers: ProviderEntry[];
  modelIndex: number;
  startsAtModel: boolean;
  setStage: (s: Stage) => void;
  setRecentIdx: (updater: (i: number) => number) => void;
  setProviderIndex: (updater: (i: number) => number) => void;
  setModelIndex: (idx: number | ((i: number) => number)) => void;
  onCommit: (provider: string, model: string, keyId?: string) => void;
  onCancel: () => void;
  loadKeysForProvider?: (provider: string) => Promise<KeySummary[]>;
  saveKey?: (provider: string, token: string) => Promise<string>;
  deleteKey?: (provider: string, keyId: string) => Promise<void>;
  loadAndShowModels: (
    name: string,
    keyId: string | undefined,
    preselectModel: string | undefined,
  ) => Promise<void>;
  selectProviderEntry: (entry: ProviderEntry) => void;
}

export function handleEscapeKeypress(stage: Stage, deps: StageHandlerDeps): boolean {
  const { recents, startsAtModel, setStage, onCancel, loadKeysForProvider } = deps;

  switch (stage.kind) {
    case 'recent':
      onCancel();
      return true;
    case 'provider':
      if (recents.length > 0) setStage({ kind: 'recent' });
      else onCancel();
      return true;
    case 'key':
      setStage({ kind: 'provider' });
      return true;
    case 'key-delete':
      setStage({
        kind: 'key',
        provider: stage.provider,
        keys: stage.keys,
        selectedIdx: stage.selectedIdx,
      });
      return true;
    case 'key-confirm-delete':
      setStage({
        kind: 'key-delete',
        provider: stage.provider,
        keys: stage.keys,
        selectedIdx: stage.selectedIdx,
      });
      return true;
    case 'key-add':
      if (loadKeysForProvider) {
        void loadKeysForProvider(stage.provider).then(keys => {
          if (keys.length === 0) onCancel();
          else setStage({ kind: 'key', provider: stage.provider, keys, selectedIdx: 0 });
        });
      } else {
        setStage({ kind: 'provider' });
      }
      return true;
    case 'key-validating':
      setStage({ kind: 'key-add', provider: stage.provider, tokenDraft: stage.token });
      return true;
    case 'key-validate-failed':
      setStage({ kind: 'key-add', provider: stage.provider, tokenDraft: stage.token });
      return true;
    case 'loading':
    case 'model':
    case 'error':
      if (startsAtModel) onCancel();
      else setStage({ kind: 'provider' });
      return true;
  }
}

export function handleStageKeypress(
  stage: Stage,
  input: string,
  key: PickerKey,
  deps: StageHandlerDeps & { recentIdx: number; providerIndex: number },
): boolean {
  if (stage.kind === 'loading' || stage.kind === 'key-validating') return true;

  switch (stage.kind) {
    case 'recent':
      return handleRecentStageKeypress(input, key, deps);
    case 'provider':
      return handleProviderStageKeypress(input, key, deps);
    case 'key':
      return handleKeyStageKeypress(stage, input, key, deps);
    case 'key-delete':
      return handleKeyDeleteStageKeypress(stage, key, deps);
    case 'key-confirm-delete':
      return handleKeyConfirmDeleteStageKeypress(stage, input, key, deps);
    case 'key-add':
      return true;
    case 'key-validate-failed':
      return handleKeyValidateFailedStageKeypress(stage, key, deps);
    case 'error':
      return handleErrorStageKeypress(input, key, deps);
    case 'model':
      return handleModelStageKeypress(stage, input, key, deps);
  }
}

function handleRecentStageKeypress(
  input: string,
  key: PickerKey,
  deps: StageHandlerDeps & { recentIdx: number },
): boolean {
  const { recents, recentIdx, setRecentIdx, setStage, onCommit } = deps;
  const lastIdx = recents.length;
  if (key.upArrow) {
    setRecentIdx(i => (i - 1 + (lastIdx + 1)) % (lastIdx + 1));
    return true;
  }
  if (key.downArrow) {
    setRecentIdx(i => (i + 1) % (lastIdx + 1));
    return true;
  }
  if (key.return) {
    if (recentIdx === lastIdx) {
      setStage({ kind: 'provider' });
      return true;
    }
    const pair = recents[recentIdx];
    if (pair) onCommit(pair.provider, pair.model, pair.keyId);
    return true;
  }
  if (input === 'p' || input === 'P') {
    setStage({ kind: 'provider' });
    return true;
  }
  const jump = indexForShortcut(input);
  if (jump >= 0 && jump < recents.length) {
    const pair = recents[jump];
    if (pair) onCommit(pair.provider, pair.model, pair.keyId);
  }
  return true;
}

function handleProviderStageKeypress(
  input: string,
  key: PickerKey,
  deps: StageHandlerDeps & { providerIndex: number },
): boolean {
  const { providers, providerIndex, setProviderIndex, selectProviderEntry } = deps;
  if (key.upArrow) {
    setProviderIndex(i => (i - 1 + providers.length) % providers.length);
    return true;
  }
  if (key.downArrow) {
    setProviderIndex(i => (i + 1) % providers.length);
    return true;
  }
  if (key.return) {
    const entry = providers[providerIndex];
    if (entry) selectProviderEntry(entry);
    return true;
  }
  const jump = indexForShortcut(input);
  if (jump >= 0 && jump < providers.length) {
    const entry = providers[jump];
    if (entry) selectProviderEntry(entry);
  }
  return true;
}

function handleKeyStageKeypress(
  stage: Extract<Stage, { kind: 'key' }>,
  input: string,
  key: PickerKey,
  deps: StageHandlerDeps,
): boolean {
  const { setStage, deleteKey, loadAndShowModels } = deps;
  const n = stage.keys.length;
  const hasDelete = n >= 1 && Boolean(deleteKey);
  const total = n + 1 + (hasDelete ? 1 : 0);
  if (key.upArrow) {
    setStage({ ...stage, selectedIdx: (stage.selectedIdx - 1 + total) % total });
    return true;
  }
  if (key.downArrow) {
    setStage({ ...stage, selectedIdx: (stage.selectedIdx + 1) % total });
    return true;
  }
  if (key.return) {
    if (stage.selectedIdx === n) {
      setStage({ kind: 'key-add', provider: stage.provider, tokenDraft: '' });
      return true;
    }
    if (hasDelete && stage.selectedIdx === n + 1) {
      setStage({
        kind: 'key-delete',
        provider: stage.provider,
        keys: stage.keys,
        selectedIdx: 0,
      });
      return true;
    }
    const chosen = stage.keys[stage.selectedIdx];
    if (chosen) {
      void loadAndShowModels(stage.provider, chosen.id, undefined);
    }
    return true;
  }
  const jump = indexForShortcut(input);
  if (jump >= 0 && jump < n) {
    const chosen = stage.keys[jump];
    if (chosen) void loadAndShowModels(stage.provider, chosen.id, undefined);
  }
  return true;
}

function handleKeyDeleteStageKeypress(
  stage: Extract<Stage, { kind: 'key-delete' }>,
  key: PickerKey,
  deps: StageHandlerDeps,
): boolean {
  const { setStage } = deps;
  const n = stage.keys.length;
  if (n === 0) {
    setStage({ kind: 'key', provider: stage.provider, keys: [], selectedIdx: 0 });
    return true;
  }
  if (key.upArrow) {
    setStage({ ...stage, selectedIdx: (stage.selectedIdx - 1 + n) % n });
    return true;
  }
  if (key.downArrow) {
    setStage({ ...stage, selectedIdx: (stage.selectedIdx + 1) % n });
    return true;
  }
  if (key.return) {
    setStage({
      kind: 'key-confirm-delete',
      provider: stage.provider,
      keys: stage.keys,
      selectedIdx: stage.selectedIdx,
    });
  }
  return true;
}

function handleKeyConfirmDeleteStageKeypress(
  stage: Extract<Stage, { kind: 'key-confirm-delete' }>,
  input: string,
  key: PickerKey,
  deps: StageHandlerDeps,
): boolean {
  const { setStage, deleteKey, loadKeysForProvider } = deps;
  if (key.return || input === 'y' || input === 'Y') {
    const target = stage.keys[stage.selectedIdx];
    const provider = stage.provider;
    if (!target || !deleteKey || !loadKeysForProvider) {
      setStage({ kind: 'key', provider, keys: stage.keys, selectedIdx: stage.selectedIdx });
      return true;
    }
    void deleteKey(provider, target.id)
      .then(() => loadKeysForProvider(provider))
      .then(keys => {
        if (keys.length === 0) {
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
    return true;
  }
  if (input === 'n' || input === 'N') {
    setStage({
      kind: 'key-delete',
      provider: stage.provider,
      keys: stage.keys,
      selectedIdx: stage.selectedIdx,
    });
  }
  return true;
}

function handleKeyValidateFailedStageKeypress(
  stage: Extract<Stage, { kind: 'key-validate-failed' }>,
  key: PickerKey,
  deps: StageHandlerDeps,
): boolean {
  const { setStage, saveKey, loadAndShowModels } = deps;
  if (key.upArrow || key.downArrow) {
    setStage({ ...stage, choice: stage.choice === 0 ? 1 : 0 });
    return true;
  }
  if (key.return) {
    if (stage.choice === 0) {
      setStage({ kind: 'key-add', provider: stage.provider, tokenDraft: stage.token });
    } else if (saveKey) {
      const provider = stage.provider;
      const token = stage.token;
      void saveKey(provider, token).then(newKeyId => {
        void loadAndShowModels(provider, newKeyId, undefined);
      });
    }
  }
  return true;
}

function handleErrorStageKeypress(input: string, key: PickerKey, deps: StageHandlerDeps): boolean {
  const { startsAtModel, onCancel, setStage } = deps;
  if (key.return || input) {
    if (startsAtModel) onCancel();
    else setStage({ kind: 'provider' });
  }
  return true;
}

function handleModelStageKeypress(
  stage: Extract<Stage, { kind: 'model' }>,
  input: string,
  key: PickerKey,
  deps: StageHandlerDeps,
): boolean {
  const { modelIndex, setModelIndex, onCommit } = deps;
  if (key.upArrow) {
    setModelIndex(i => (i - 1 + stage.models.length) % stage.models.length);
    return true;
  }
  if (key.downArrow) {
    setModelIndex(i => (i + 1) % stage.models.length);
    return true;
  }
  if (key.return) {
    const model = stage.models[modelIndex];
    if (model) onCommit(stage.provider, model, stage.keyId);
    return true;
  }
  const jump = indexForShortcut(input);
  if (jump >= 0 && jump < stage.models.length) {
    const model = stage.models[jump];
    if (model) onCommit(stage.provider, model, stage.keyId);
  }
  return true;
}
