import React from 'react';
import { Box } from 'ink';
import { ConversationDisplay } from '../components/conversation-display.js';
import { PermissionPanel } from '../components/permission-panel.js';
import { PlanApprovalPanel } from '../components/plan-approval-panel.js';
import { ProviderPicker } from '../components/provider-picker/index.js';
import { RotationPromptPanel } from '../components/rotation-prompt-panel.js';
import { StatusBar, selectDisplayTokens } from '../components/status-bar.js';
import { SessionInputRow } from './SessionInputRow.js';
import type { ToolCallSummary } from '../types.js';
import type { RunState, PermissionRequestState } from '../agent-loop/agent-loop-types.js';
import type { PromptTokensCarrier } from '../../../providers/usage.js';
import type { TabsContextValue } from '../tabs/TabsContext.js';

type SpinnerInfo = { label: string; color: string } | undefined;

type RotationPromptDisplay = {
  provider: string;
  model: string;
  reason: 'rate-limit' | 'auth';
} | null;

interface SessionViewProps {
  isActive: boolean;
  useStatic: boolean;
  showFullOutput: boolean;
  emojiMode: boolean;
  userEmoji?: string;
  items: React.ComponentProps<typeof ConversationDisplay>['items'];
  streamingText: string;
  pendingToolCall: ToolCallSummary | null;
  spinner: SpinnerInfo;
  permissionRequest: PermissionRequestState | undefined;
  planMode: boolean;
  plannedCallsLength: number;
  state: RunState;
  pickerOpen: boolean;
  providerPickerProps: React.ComponentProps<typeof ProviderPicker>;
  rotationPrompt: RotationPromptDisplay;
  tabs: TabsContextValue | null;
  tabLabel?: string;
  columns?: number;
  inputAccentColor: 'yellow' | 'cyan' | 'green';
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  handleSubmit: (value: string) => void;
  activity: string | null;
  providerName: string;
  model: string;
  lastUsage: PromptTokensCarrier | undefined;
  estimatedTokens: number | undefined;
  contextWindow: number;
  sessionTurns: number;
  sessionToolCalls: number;
  queueLength: number;
  gitBranch: string | undefined;
  gitDirty: boolean | null;
  cwd: string;
}

export function SessionView(props: SessionViewProps): React.ReactElement {
  return (
    <Box flexDirection="column" display={props.isActive ? 'flex' : 'none'}>
      <ConversationDisplay
        items={props.items}
        streamingText={props.streamingText}
        pendingToolCall={props.pendingToolCall}
        spinner={props.spinner}
        useStatic={props.useStatic}
        showFullOutput={props.showFullOutput}
        emojiMode={props.emojiMode}
        userEmoji={props.userEmoji}
      />

      {props.permissionRequest && (
        <PermissionPanel toolName={props.permissionRequest.toolName} args={props.permissionRequest.args} />
      )}

      {props.planMode && props.plannedCallsLength > 0 && props.state === 'idle' && (
        <PlanApprovalPanel count={props.plannedCallsLength} />
      )}

      {props.pickerOpen && <ProviderPicker {...props.providerPickerProps} />}

      {props.rotationPrompt && (
        <RotationPromptPanel
          provider={props.rotationPrompt.provider}
          model={props.rotationPrompt.model}
          reason={props.rotationPrompt.reason}
        />
      )}

      <SessionInputRow
        isActive={props.isActive}
        tabs={props.tabs}
        tabLabel={props.tabLabel}
        showFullOutput={props.showFullOutput}
        columns={props.columns}
        inputAccentColor={props.inputAccentColor}
        input={props.input}
        setInput={props.setInput}
        handleSubmit={props.handleSubmit}
        pickerOpen={props.pickerOpen}
      />

      <StatusBar
        planMode={props.planMode}
        state={props.state}
        activity={props.activity}
        providerName={props.providerName}
        model={props.model}
        {...selectDisplayTokens(props.lastUsage, props.estimatedTokens)}
        contextWindow={props.contextWindow}
        sessionTurns={props.sessionTurns}
        sessionToolCalls={props.sessionToolCalls}
        queueLength={props.queueLength}
        gitBranch={props.gitBranch}
        gitDirty={props.gitDirty}
        cwd={props.cwd}
      />
    </Box>
  );
}
