import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import {
  type ModelDisplayInfo,
  type ProviderEntry,
  type RecentPair,
  type Stage,
  type ValidateResult,
  type KeySummary,
} from './provider-picker-types.js';
import {
  ConfirmDeleteStage,
  ErrorStage,
  KeyAddStage,
  KeyDeleteStage,
  KeyStage,
  LoadingStage,
  ModelStage,
  ProviderStage,
  RecentStage,
  ValidatingStage,
  ValidateFailedStage,
} from './provider-picker-stages.js';
import { useProviderPickerKeys } from './provider-picker-keys.js';

// Re-export types so existing call sites that import from this module
// (e.g. Session.tsx, headless callers) keep working without churn.
export type { RecentPair, ProviderEntry } from './provider-picker-types.js';

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
    ...(loadKeysForProvider ? { loadKeysForProvider } : {}),
    ...(saveKey ? { saveKey } : {}),
    ...(deleteKey ? { deleteKey } : {}),
    ...(multiKeyProviders ? { multiKeyProviders } : {}),
    ...(initialProvider ? { initialProvider } : {}),
    ...(initialKeyId ? { initialKeyId } : {}),
    ...(initialModel ? { initialModel } : {}),
    isFallbackPicker,
    startsAtModel,
    onCommit,
    onCancel,
  });

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
    switch (stage.kind) {
      case 'recent':
        return <RecentStage recents={recents} recentsLoading={recentsLoading} recentIdx={recentIdx} />;
      case 'provider':
        return <ProviderStage providers={providers} providerIndex={providerIndex} />;
      case 'key':
        return (
          <KeyStage stage={stage} hasDelete={stage.keys.length >= 1 && Boolean(deleteKey)} />
        );
      case 'key-delete':
        return <KeyDeleteStage stage={stage} />;
      case 'key-confirm-delete':
        return <ConfirmDeleteStage stage={stage} />;
      case 'key-add':
        return (
          <KeyAddStage
            stage={stage}
            onChange={next => setStage({ ...stage, tokenDraft: next })}
            onSubmit={value => {
              const trimmed = value.trim();
              if (!trimmed) return;
              setStage({ kind: 'key-validating', provider: stage.provider, token: trimmed });
            }}
          />
        );
      case 'key-validating':
        return <ValidatingStage stage={stage} />;
      case 'key-validate-failed':
        return <ValidateFailedStage stage={stage} />;
      case 'loading':
        return <LoadingStage stage={stage} />;
      case 'error':
        return <ErrorStage stage={stage} startsAtModel={startsAtModel} />;
      case 'model':
        return <ModelStage stage={stage} modelIndex={modelIndex} getModelInfo={getModelInfo} />;
    }
  }
}
