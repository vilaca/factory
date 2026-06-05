import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useStdout } from 'ink';
import { makePickerCommitHandler } from '../components/provider-picker/commit-handler.js';
import type {
  ProviderPicker,
  ProviderEntry,
  RecentPair,
} from '../components/provider-picker/index.js';
import { useAgentLoop, type AgentLoopApi } from '../agent-loop/use-agent-loop.js';
import { TabsContext } from '../tabs/TabsContext.js';
import type { Provider } from '../../../providers/types.js';
import { listProviderNames, DESCRIPTORS, DESCRIPTOR_LIST } from '../../../providers/registry.js';
import { getRecentSessions } from '../../../core/session/session-log.js';
import { useRotationFallback } from '../hooks/use-rotation-fallback.js';
import { useCompactionPicker } from '../hooks/use-compaction-picker.js';
import { useSessionInput } from '../hooks/use-session-input.js';
import { SessionView } from './SessionView.js';
import { buildPickerAdapter } from './picker-adapter.js';
import type { SessionProps } from './types.js';

function buildProviderList(): ProviderEntry[] {
  return listProviderNames().map(name => {
    const desc = (DESCRIPTORS as Record<string, { label: string } | undefined>)[name];
    return { name, label: desc?.label ?? name };
  });
}

const SIMPLE_PROMPT_PROVIDERS = new Set(
  DESCRIPTOR_LIST.filter(d => d.authFlow === 'simple-prompt').map(d => d.name),
);

export function SessionContainer(props: SessionProps): React.ReactElement {
  const isActive = props.isActive ?? true;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [input, setInput] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerRecents, setPickerRecents] = useState<RecentPair[]>([]);
  const [pickerRecentsLoading, setPickerRecentsLoading] = useState(false);
  const [showFullOutput, setShowFullOutput] = useState(false);
  const showFullOutputRef = useRef(showFullOutput);
  showFullOutputRef.current = showFullOutput;

  const agent = useAgentLoop(props);
  const { rotationPrompt, fallbackPickerResolver } = useRotationFallback(agent, setPickerOpen);
  const { compactionPickerResolver, openCompactionPicker } = useCompactionPicker(setPickerOpen);
  const pickerProviderCache = useRef(new Map<string, Provider>());

  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    setPickerRecentsLoading(true);
    void getRecentSessions(8).then(sessions => {
      if (cancelled) return;
      const seen = new Set<string>();
      const pairs: RecentPair[] = [];
      for (const s of sessions) {
        const key = `${s.provider}\0${s.model}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({
          provider: s.provider,
          model: s.model,
          ...(s.status ? { status: s.status } : {}),
          ...(s.keyId ? { keyId: s.keyId } : {}),
        });
      }
      setPickerRecents(pairs);
      setPickerRecentsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [pickerOpen]);

  const everMultiTabRef = useRef(false);
  const tabsCtx = useContext(TabsContext);
  if (tabsCtx && tabsCtx.tabs.length > 1) everMultiTabRef.current = true;
  const useStatic = !tabsCtx || (tabsCtx.tabs.length === 1 && !everMultiTabRef.current);

  const apiRef = useRef<AgentLoopApi>(agent);
  apiRef.current = agent;
  const tabs = tabsCtx;
  const tabId = props.tabId;
  useEffect(() => {
    if (!tabs || tabId === undefined) return;
    const getter = (): AgentLoopApi => apiRef.current;
    tabs.registry.register(tabId, getter);
    return () => {
      tabs.registry.unregister(tabId);
    };
  }, [tabs, tabId]);

  const isWaiting =
    !!agent.permissionRequest ||
    !!rotationPrompt ||
    (agent.planMode && agent.plannedCalls.length > 0 && agent.state === 'idle');
  useEffect(() => {
    if (!tabs || tabId === undefined) return;
    tabs.setWaiting(tabId, isWaiting);
  }, [tabs, tabId, isWaiting]);

  const { handleSubmit } = useSessionInput({
    isActive,
    agent,
    exit,
    tabs,
    input,
    setInput,
    pickerOpen,
    setPickerOpen,
    showFullOutputRef,
    setShowFullOutput,
    rotationPrompt,
    openCompactionPicker,
  });

  const inputAccentColor = agent.permissionRequest
    ? 'yellow'
    : agent.state === 'running'
      ? 'cyan'
      : 'green';
  const providerList = useMemo<ProviderEntry[]>(buildProviderList, []);
  const spinner =
    !agent.permissionRequest && agent.compacting
      ? {
          label: agent.compacting.aggressive ? 'Compacting (aggressive)…' : 'Compacting context…',
          color: 'yellow',
        }
      : !agent.permissionRequest && agent.runningTool
        ? { label: `Running ${agent.runningTool}…`, color: 'magenta' }
        : !agent.permissionRequest && agent.thinking
          ? { label: 'Thinking…', color: 'cyan' }
          : undefined;

  const pickerAdapter = buildPickerAdapter({
    pickerProviderCache,
    providerName: agent.providerName,
    propsProvider: props.provider,
    refsProvider: agent.refs.current?.provider,
  });

  const providerPickerProps: React.ComponentProps<typeof ProviderPicker> = {
    providers: providerList,
    recents: pickerRecents,
    recentsLoading: pickerRecentsLoading,
    initialProvider: agent.providerName,
    initialModel: agent.model,
    getModelInfo: pickerAdapter.getModelInfo,
    multiKeyProviders: SIMPLE_PROMPT_PROVIDERS,
    loadModels: pickerAdapter.loadModels,
    loadKeysForProvider: pickerAdapter.loadKeysForProvider,
    validateKey: pickerAdapter.validateKey,
    saveKey: pickerAdapter.saveKey,
    deleteKey: pickerAdapter.deleteKey,
    purpose:
      fallbackPickerResolver || compactionPickerResolver
        ? 'select-rotation-entry'
        : 'select-active',
    onCancel: () => {
      if (compactionPickerResolver) {
        compactionPickerResolver(null);
      } else if (fallbackPickerResolver) {
        fallbackPickerResolver(null);
      } else {
        setPickerOpen(false);
      }
    },
    onCommit: makePickerCommitHandler({
      compactionPickerResolver,
      fallbackPickerResolver,
      setProviderByName: agent.setProviderByName,
      setPickerOpen,
    }),
    onError: (source, message) => {
      agent.addNotice('danger', `${source}: ${message}`);
    },
  };

  return (
    <SessionView
      isActive={isActive}
      useStatic={useStatic}
      showFullOutput={showFullOutput}
      emojiMode={agent.emojiMode}
      userEmoji={agent.userEmoji}
      items={agent.items}
      streamingText={agent.streamingText}
      pendingToolCall={agent.pendingToolCall}
      spinner={spinner}
      permissionRequest={agent.permissionRequest}
      planMode={agent.planMode}
      plannedCallsLength={agent.plannedCalls.length}
      state={agent.state}
      pickerOpen={pickerOpen}
      providerPickerProps={providerPickerProps}
      rotationPrompt={
        rotationPrompt
          ? {
              provider: rotationPrompt.provider,
              model: rotationPrompt.model,
              reason: rotationPrompt.reason,
            }
          : null
      }
      tabs={tabs}
      tabLabel={props.tabLabel}
      columns={stdout.columns}
      inputAccentColor={inputAccentColor}
      input={input}
      setInput={setInput}
      handleSubmit={value => {
        void handleSubmit(value);
      }}
      activity={agent.activity}
      providerName={agent.providerName}
      model={agent.model}
      lastUsage={agent.lastUsage}
      estimatedTokens={agent.estimatedTokens}
      contextWindow={agent.contextWindow}
      sessionTurns={agent.sessionTurns}
      sessionToolCalls={agent.sessionToolCalls}
      queueLength={agent.queueLength}
      gitBranch={agent.gitBranch}
      gitDirty={agent.gitDirty}
      cwd={agent.cwd}
    />
  );
}
