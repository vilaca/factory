import React, { useState } from 'react';
import { Box, Text } from 'ink';
import {
  type ModelDisplayInfo,
  type ProviderEntry,
  type RecentPair,
  type Stage,
  type ValidateResult,
  type KeySummary,
} from './types.js';
import { useProviderPickerKeys } from './keys.js';
import { prepareModels } from './prepare.js';
import { useValidateKeyEffect } from './validate.js';
import { pickerEscLabel, pickerFooterText, renderPickerBody } from './render-body.js';

// Re-export types so existing call sites that import from this module
// (e.g. Session.tsx, headless callers) keep working without churn.
export type { RecentPair, ProviderEntry } from './types.js';

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
  /** Provider names that use device-flow auth. When model loading fails for
   *  these without credentials, the picker either runs auth inline (if
   *  runDeviceFlowAuth is provided) or commits provider-only so the host
   *  can drive the flow. */
  deviceFlowProviders?: ReadonlySet<string>;
  /** When provided, the picker handles device-flow auth internally: it shows
   *  the device code in the loading stage, then retries model listing after
   *  the callback resolves. The callback must persist the acquired token before
   *  returning so the loadModels retry succeeds. */
  runDeviceFlowAuth?: (
    provider: string,
    onCode: (info: { userCode: string; verificationUri: string; expiresIn: number }) => void,
  ) => Promise<void>;
  /** Returns true when the provider already has stored device-flow credentials. */
  isDeviceFlowAuthed?: (provider: string) => Promise<boolean>;
  /** Clears stored device-flow credentials and returns to the provider stage. */
  revokeDeviceFlowAuth?: (provider: string) => Promise<void>;
  initialProvider?: string;
  initialModel?: string;
  initialKeyId?: string;
  onCommit: (provider: string, model: string, keyId?: string) => void;
  onCancel: () => void;
  /** Invoked when an error stage is shown — lets the host log the failure
   *  alongside the visible notice (the picker itself can't see sessionLogger). */
  onError?: (source: string, message: string) => void;
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

// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- TODO(complexity)
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
    deviceFlowProviders,
    runDeviceFlowAuth,
    isDeviceFlowAuthed,
    revokeDeviceFlowAuth,
    initialProvider,
    initialModel,
    initialKeyId,
    onCommit,
    onCancel,
    onError,
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
        models: prepareModels(
          preloadedModels ?? [],
          getModelInfo ? m => getModelInfo(initialProvider ?? '', m) : undefined,
        ),
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

  useValidateKeyEffect({
    stage,
    setStage,
    setModelIndex,
    ...(validateKey ? { validateKey } : {}),
    ...(saveKey ? { saveKey } : {}),
    ...(getModelInfo ? { getModelInfo } : {}),
    ...(onError ? { onError } : {}),
  });

  useProviderPickerKeys({
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
    ...(getModelInfo ? { getModelInfo } : {}),
    ...(loadKeysForProvider ? { loadKeysForProvider } : {}),
    ...(saveKey ? { saveKey } : {}),
    ...(deleteKey ? { deleteKey } : {}),
    ...(multiKeyProviders ? { multiKeyProviders } : {}),
    ...(deviceFlowProviders ? { deviceFlowProviders } : {}),
    ...(runDeviceFlowAuth ? { runDeviceFlowAuth } : {}),
    ...(isDeviceFlowAuthed ? { isDeviceFlowAuthed } : {}),
    ...(revokeDeviceFlowAuth ? { revokeDeviceFlowAuth } : {}),
    ...(initialProvider ? { initialProvider } : {}),
    ...(initialKeyId ? { initialKeyId } : {}),
    ...(initialModel ? { initialModel } : {}),
    isFallbackPicker,
    startsAtModel,
    onCommit,
    onCancel,
    ...(onError ? { onError } : {}),
  });

  const body = renderPickerBody({
    stage,
    setStage,
    recents,
    recentsLoading,
    recentIdx,
    providers,
    providerIndex,
    modelIndex,
    startsAtModel,
    hasDeleteKey: Boolean(deleteKey),
    ...(getModelInfo ? { getModelInfo } : {}),
  });
  const footer = (
    <Text dimColor>
      {pickerFooterText(stage, pickerEscLabel(stage, recents.length > 0, startsAtModel))}
    </Text>
  );
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
}
