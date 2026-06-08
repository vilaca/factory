import { errorMessage } from '../../../../utils/errors.js';
import { prepareModels } from './prepare.js';
import type { ModelDisplayInfo, ProviderEntry, Stage, KeySummary } from './types.js';

interface CreatePickerDataActionsArgs {
  setStage: (s: Stage) => void;
  setModelIndex: (idx: number) => void;
  loadModels: (provider: string, keyId?: string) => Promise<string[]>;
  getModelInfo?: (provider: string, model: string) => ModelDisplayInfo | undefined;
  loadKeysForProvider?: (provider: string) => Promise<KeySummary[]>;
  multiKeyProviders?: ReadonlySet<string>;
  deviceFlowProviders?: ReadonlySet<string>;
  /** Called on device-flow providers when credentials are missing and no
   *  runDeviceFlowAuth is provided — lets the host drive auth outside the picker. */
  onCommitProviderOnly?: (provider: string) => void;
  /** When provided, auth is handled inside the picker: the callback runs the
   *  device flow and calls onCode when the code is ready. After it resolves,
   *  loadModels is retried and the model list is shown inside the picker. */
  runDeviceFlowAuth?: (
    provider: string,
    onCode: (info: { userCode: string; verificationUri: string; expiresIn: number }) => void,
  ) => Promise<void>;
  /** Returns true when the provider already has device-flow credentials stored. */
  isDeviceFlowAuthed?: (provider: string) => Promise<boolean>;
  /** Clears stored device-flow credentials for the provider. */
  revokeDeviceFlowAuth?: (provider: string) => Promise<void>;
  isFallbackPicker: boolean;
  initialProvider?: string;
  initialKeyId?: string;
  initialModel?: string;
  onError?: (source: string, message: string) => void;
}

export interface PickerDataActions {
  isMultiKey: (name: string) => boolean;
  loadAndShowModels: (
    name: string,
    keyId: string | undefined,
    preselectModel: string | undefined,
  ) => Promise<void>;
  enterProvider: (name: string, preselectModel?: string) => Promise<void>;
  selectProviderEntry: (entry: ProviderEntry) => void;
  revokeAndReturnToProvider: (provider: string) => Promise<void>;
}

/**
 * Data/controller layer for ProviderPicker.
 *
 * Owns async fetch + preparation transitions (keys/models/error/loading)
 * so keyboard dispatch can stay focused on input routing.
 */
export function createPickerDataActions(args: CreatePickerDataActionsArgs): PickerDataActions {
  const {
    setStage,
    setModelIndex,
    loadModels,
    getModelInfo,
    loadKeysForProvider,
    multiKeyProviders,
    deviceFlowProviders,
    onCommitProviderOnly,
    runDeviceFlowAuth,
    isDeviceFlowAuthed,
    revokeDeviceFlowAuth,
    isFallbackPicker,
    initialProvider,
    initialKeyId,
    initialModel,
    onError,
  } = args;

  function reportError(source: string, message: string): void {
    if (onError) onError(source, message);
  }

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
    alreadyAuthed = false,
  ): Promise<void> {
    setStage({ kind: 'loading', provider: name, ...(keyId ? { keyId } : {}) });
    try {
      const raw = await loadModels(name, keyId);
      const models = prepareModels(raw, getModelInfo ? m => getModelInfo(name, m) : undefined);
      if (models.length === 0) {
        reportError(`picker:loadModels:${name}`, 'no models returned');
        setStage({ kind: 'error', provider: name, message: 'no models returned' });
        return;
      }
      const idx = preselectModel ? Math.max(0, models.indexOf(preselectModel)) : 0;
      setModelIndex(idx);
      setStage({ kind: 'model', provider: name, models, ...(keyId ? { keyId } : {}) });
    } catch (err) {
      const msg = errorMessage(err);
      if (!alreadyAuthed && deviceFlowProviders?.has(name) && runDeviceFlowAuth) {
        try {
          await runDeviceFlowAuth(name, ({ userCode, verificationUri, expiresIn }) => {
            setStage({
              kind: 'loading',
              provider: name,
              ...(keyId ? { keyId } : {}),
              hint: [
                `Open: ${verificationUri}`,
                `Code: ${userCode}`,
                `(expires in ${Math.ceil(expiresIn / 60)}m)`,
              ],
            });
          });
          await loadAndShowModels(name, keyId, preselectModel, true);
        } catch (authErr) {
          const authMsg = errorMessage(authErr);
          reportError(`picker:auth:${name}`, authMsg);
          setStage({ kind: 'error', provider: name, message: authMsg });
        }
        return;
      }
      if (deviceFlowProviders?.has(name) && onCommitProviderOnly) {
        onCommitProviderOnly(name);
        return;
      }
      reportError(`picker:loadModels:${name}`, msg);
      setStage({ kind: 'error', provider: name, message: msg });
    }
  }

  async function revokeAndReturnToProvider(provider: string): Promise<void> {
    if (revokeDeviceFlowAuth) {
      await revokeDeviceFlowAuth(provider);
    }
    setStage({ kind: 'provider' });
  }

  async function enterProvider(name: string, preselectModel?: string): Promise<void> {
    if (!isFallbackPicker && deviceFlowProviders?.has(name) && isDeviceFlowAuthed) {
      const authed = await isDeviceFlowAuthed(name);
      if (authed) {
        setStage({ kind: 'device-flow-manage', provider: name, selectedIdx: 0 });
        return;
      }
    }
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
        const msg = errorMessage(err);
        reportError(`picker:loadKeys:${name}`, msg);
        setStage({ kind: 'error', provider: name, message: msg });
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

  return {
    isMultiKey,
    loadAndShowModels,
    enterProvider,
    selectProviderEntry,
    revokeAndReturnToProvider,
  };
}
