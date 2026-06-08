import React from 'react';
import type { ModelDisplayInfo, ProviderEntry, RecentPair, Stage } from './types.js';
import {
  ConfirmDeleteStage,
  DeviceFlowManageStage,
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
} from './stages.js';

interface RenderBodyArgs {
  stage: Stage;
  setStage: (s: Stage) => void;
  recents: RecentPair[];
  recentsLoading?: boolean;
  recentIdx: number;
  providers: ProviderEntry[];
  providerIndex: number;
  modelIndex: number;
  startsAtModel: boolean;
  hasDeleteKey: boolean;
  getModelInfo?: (provider: string, model: string) => ModelDisplayInfo | undefined;
}

/**
 * Stage-to-component dispatch for the picker. Lives outside `ProviderPicker`
 * so its switch + key-add closure don't inflate the parent function's
 * cognitive-complexity count.
 */
export function renderPickerBody(args: RenderBodyArgs): React.ReactElement | null {
  const {
    stage,
    setStage,
    recents,
    recentsLoading,
    recentIdx,
    providers,
    providerIndex,
    modelIndex,
    startsAtModel,
    hasDeleteKey,
    getModelInfo,
  } = args;
  switch (stage.kind) {
    case 'recent':
      return (
        <RecentStage recents={recents} recentsLoading={recentsLoading} recentIdx={recentIdx} />
      );
    case 'provider':
      return <ProviderStage providers={providers} providerIndex={providerIndex} />;
    case 'key':
      return <KeyStage stage={stage} hasDelete={stage.keys.length >= 1 && hasDeleteKey} />;
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
    case 'device-flow-manage':
      return <DeviceFlowManageStage stage={stage} />;
  }
}

export function pickerFooterText(stage: Stage, escLabelText: string): string {
  if (stage.kind === 'key-add') return 'type/paste token · Enter validate · Esc back';
  if (stage.kind === 'key-validating') return 'validating…';
  if (stage.kind === 'key-validate-failed') return '↑/↓ choose · Enter confirm · Esc back to edit';
  if (stage.kind === 'key-confirm-delete') return 'y/Enter confirm · n/Esc cancel';
  if (stage.kind === 'device-flow-manage') return 'Enter use · D disconnect · Esc back';
  return `↑/↓ navigate · 0–9/A–Z jump · Enter select · Esc ${escLabelText}`;
}

export function pickerEscLabel(stage: Stage, hasRecents: boolean, startsAtModel: boolean): string {
  if (stage.kind === 'recent') return 'cancel';
  if (stage.kind === 'provider') return hasRecents ? 'back' : 'cancel';
  if (startsAtModel) return 'cancel';
  return 'back';
}
