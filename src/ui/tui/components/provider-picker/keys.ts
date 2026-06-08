import { useInput } from 'ink';
import {
  type KeySummary,
  type ModelDisplayInfo,
  type ProviderEntry,
  type RecentPair,
  type Stage,
} from './types.js';
import { createPickerDataActions } from './data-actions.js';
import { handleEscapeKeypress, handleStageKeypress } from './stage-key-handlers.js';

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
  getModelInfo?: (provider: string, model: string) => ModelDisplayInfo | undefined;
  loadKeysForProvider?: (provider: string) => Promise<KeySummary[]>;
  saveKey?: (provider: string, token: string) => Promise<string>;
  deleteKey?: (provider: string, keyId: string) => Promise<void>;
  multiKeyProviders?: ReadonlySet<string>;
  deviceFlowProviders?: ReadonlySet<string>;
  runDeviceFlowAuth?: (
    provider: string,
    onCode: (info: { userCode: string; verificationUri: string; expiresIn: number }) => void,
  ) => Promise<void>;
  isDeviceFlowAuthed?: (provider: string) => Promise<boolean>;
  revokeDeviceFlowAuth?: (provider: string) => Promise<void>;
  initialProvider?: string;
  initialKeyId?: string;
  initialModel?: string;
  isFallbackPicker: boolean;
  startsAtModel: boolean;
  onCommit: (provider: string, model: string, keyId?: string) => void;
  onCancel: () => void;
  onError?: (source: string, message: string) => void;
}

/**
 * Owns keyboard wiring for ProviderPicker.
 *
 * Data transitions live in `createPickerDataActions`; stage-specific key
 * handling lives in `stage-key-handlers.ts`.
 */
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
    getModelInfo,
    loadKeysForProvider,
    saveKey,
    deleteKey,
    multiKeyProviders,
    deviceFlowProviders,
    runDeviceFlowAuth,
    isDeviceFlowAuthed,
    revokeDeviceFlowAuth,
    initialProvider,
    initialKeyId,
    initialModel,
    isFallbackPicker,
    startsAtModel,
    onCommit,
    onCancel,
    onError,
  } = args;

  const { loadAndShowModels, selectProviderEntry, revokeAndReturnToProvider } =
    createPickerDataActions({
      setStage,
      setModelIndex: idx => setModelIndex(idx),
      loadModels,
      ...(getModelInfo ? { getModelInfo } : {}),
      ...(loadKeysForProvider ? { loadKeysForProvider } : {}),
      ...(multiKeyProviders ? { multiKeyProviders } : {}),
      ...(deviceFlowProviders ? { deviceFlowProviders } : {}),
      ...(runDeviceFlowAuth ? { runDeviceFlowAuth } : {}),
      ...(isDeviceFlowAuthed ? { isDeviceFlowAuthed } : {}),
      ...(revokeDeviceFlowAuth ? { revokeDeviceFlowAuth } : {}),
      onCommitProviderOnly: (provider: string) => onCommit(provider, ''),
      isFallbackPicker,
      ...(initialProvider ? { initialProvider } : {}),
      ...(initialKeyId ? { initialKeyId } : {}),
      ...(initialModel ? { initialModel } : {}),
      ...(onError ? { onError } : {}),
    });

  useInput((input, key) => {
    if (key.escape) {
      const handled = handleEscapeKeypress(stage, {
        recents,
        providers,
        modelIndex,
        startsAtModel,
        setStage,
        setRecentIdx,
        setProviderIndex,
        setModelIndex,
        onCommit,
        onCancel,
        ...(loadKeysForProvider ? { loadKeysForProvider } : {}),
        ...(saveKey ? { saveKey } : {}),
        ...(deleteKey ? { deleteKey } : {}),
        loadAndShowModels,
        selectProviderEntry,
        revokeAndReturnToProvider,
      });
      if (handled) return;
    }

    // TextInput owns input on key-add. Picker only listens for Esc.
    if (stage.kind === 'key-add') return;

    handleStageKeypress(stage, input, key, {
      recents,
      providers,
      recentIdx,
      providerIndex,
      modelIndex,
      startsAtModel,
      setStage,
      setRecentIdx,
      setProviderIndex,
      setModelIndex,
      onCommit,
      onCancel,
      ...(loadKeysForProvider ? { loadKeysForProvider } : {}),
      ...(saveKey ? { saveKey } : {}),
      ...(deleteKey ? { deleteKey } : {}),
      loadAndShowModels,
      selectProviderEntry,
      revokeAndReturnToProvider,
    });
  });
}
