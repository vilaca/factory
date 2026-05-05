import React, { useContext, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { Provider } from '../../providers/types.js';
import type { AgentConfig } from '../../core/config-types.js';
import { ConversationDisplay } from './components/conversation-display.js';
import { Separator } from './components/separator.js';
import { StatusBar } from './components/status-bar.js';
import { PermissionPanel, parsePermissionInput } from './components/permission-panel.js';
import { PlanApprovalPanel, parsePlanInput } from './components/plan-approval-panel.js';
import { useAgentLoop, type AgentLoopApi } from './use-agent-loop.js';
import { dispatchSlashCommand } from './slash-commands.js';
import { TabsContext } from './tabs/TabsContext.js';

export interface SessionProps {
  model: string;
  systemPrompt: string;
  provider: Provider;
  agentConfig?: AgentConfig;
  autoAllowTools?: string[];
  useTextToolFallback?: boolean;
  nativeToolSupport?: boolean;
  enableSessionLog?: boolean;
  planMode?: boolean;
  enableCorrector?: boolean;
  mcpInfo?: { servers: string[]; toolCount: number };
  gitBranch?: string;
  gitDirty?: boolean | null;
  validationWarning?: string;
  isActive?: boolean;
  tabId?: number;
}

export function Session(props: SessionProps): React.ReactElement {
  const isActive = props.isActive ?? true;
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const agent = useAgentLoop(props);

  // <Static> can only be used once we know we're staying single-tab. Once a
  // second tab has ever existed, switch to .map permanently — flipping back
  // to Static after the second tab closes would cause Ink to re-flush the
  // committed scrollback and double-print prior turns.
  const everMultiTabRef = useRef(false);
  const tabsCtx = useContext(TabsContext);
  if (tabsCtx && tabsCtx.tabs.length > 1) everMultiTabRef.current = true;
  const useStatic = !tabsCtx || (tabsCtx.tabs.length === 1 && !everMultiTabRef.current);

  // Register a stable getter with the tabs registry so consumers (TabStrip,
  // tab-management hotkeys, parent slash commands) can read this session's
  // current AgentLoopApi without re-registering on every render.
  const apiRef = useRef<AgentLoopApi>(agent);
  apiRef.current = agent;
  const tabs = tabsCtx;
  const tabId = props.tabId;
  useEffect(() => {
    if (!tabs || tabId === undefined) return;
    const getter = (): AgentLoopApi => apiRef.current;
    tabs.registry.register(tabId, getter);
    return () => { tabs.registry.unregister(tabId); };
  }, [tabs, tabId]);

  // Push status to the registry so the TabStrip can badge tabs that are
  // running, awaiting permission, or have completed work while hidden.
  // The 'attention' badge persists across `state` flips until the tab gains
  // focus, so a hidden tab that finishes its turn keeps its mark until the
  // user looks at it.
  const prevStateRef = useRef(agent.state);
  const attentionRef = useRef(false);
  useEffect(() => {
    if (!tabs || tabId === undefined) return;
    const prev = prevStateRef.current;
    prevStateRef.current = agent.state;
    if (isActive) attentionRef.current = false;
    else if (prev === 'running' && agent.state === 'idle') attentionRef.current = true;

    let badge: 'running' | 'awaiting-permission' | 'attention' | null = null;
    if (agent.state === 'running') badge = 'running';
    else if (agent.state === 'awaiting-permission') badge = 'awaiting-permission';
    else if (attentionRef.current) badge = 'attention';
    tabs.registry.setStatus(tabId, { badge });
  }, [tabs, tabId, agent.state, isActive]);

  const {
    items,
    state,
    thinking,
    compacting,
    runningTool,
    streamingText,
    permissionRequest,
    pendingToolCall,
    plannedCalls,
    planMode,
    providerName,
    model,
    sessionTurns,
    sessionToolCalls,
    lastUsage,
    estimatedTokens,
    queueLength,
    gitBranch,
    gitDirty,
    cwd,
    refs,
    addNotice,
  } = agent;

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') {
      // While a turn is running, Ctrl+C aborts it without exiting — matches
      // shell muscle memory ("interrupt this command, stay in the prompt").
      // When idle, Ctrl+C exits the process.
      if (state === 'running') {
        addNotice('warn', '⏸ Ctrl+C — aborting agent run.');
        agent.abort();
        return;
      }
      agent.abort();
      exit();
      return;
    }
    if (key.escape && state === 'running') {
      addNotice('warn', '⏸ Esc — aborting agent run.');
      agent.abort();
      return;
    }
    if (key.upArrow) {
      const next = agent.historyUp(input);
      if (next !== null) setInput(next);
      return;
    }
    if (key.downArrow) {
      const next = agent.historyDown();
      if (next !== null) setInput(next);
      return;
    }
  }, { isActive });

  async function handleSubmit(value: string): Promise<void> {
    const trimmed = value.trim();
    setInput('');
    agent.recordHistory(trimmed);
    if (!trimmed) return;

    if (state === 'running') {
      // Slash commands always fire immediately — they are UI/state ops,
      // not prompts for the agent. Only plain text gets queued.
      if (trimmed.startsWith('/')) {
        const [cmd, ...rest] = trimmed.split(' ');
        refs.current?.sessionLogger?.logCommand(cmd, rest.join(' '));
        void dispatchSlashCommand(cmd, rest.join(' ').trim(), { agent, exit, tabs: tabs ?? undefined });
        return;
      }
      agent.queueInput(trimmed);
      return;
    }

    if (state === 'awaiting-permission') {
      // Submitted via TextInput while a permission is pending — route to resolver.
      const decision = parsePermissionInput(trimmed);
      agent.respondToPermission(decision);
      return;
    }

    // Idle — process and drain queue.
    await processIdleInput(trimmed);
  }

  async function processIdleInput(trimmed: string): Promise<void> {
    if (!refs.current) return;

    // Plan-mode approval shortcuts when a plan is queued.
    if (refs.current.planMode && plannedCalls.length > 0) {
      const kind = parsePlanInput(trimmed);
      if (kind === 'approve') {
        refs.current.sessionLogger?.logCommand('/approve', '');
        await agent.approvePlan();
        return;
      }
      if (kind === 'cancel') {
        refs.current.sessionLogger?.logCommand('/cancel', '');
        agent.cancelPlan();
        addNotice('info', 'Plan dropped. Still in plan mode.');
        return;
      }
      // 'revise' — non-slash input drops the plan and treats the input as a
      // follow-up prompt; slash commands fall through to the dispatcher below.
      if (!trimmed.startsWith('/')) {
        agent.cancelPlan();
        addNotice('info', '(revising plan...)');
      }
    }

    if (trimmed.startsWith('/')) {
      const [cmd, ...rest] = trimmed.split(' ');
      refs.current.sessionLogger?.logCommand(cmd, rest.join(' '));
      const handled = await dispatchSlashCommand(cmd, rest.join(' ').trim(), { agent, exit, tabs: tabs ?? undefined });
      if (handled) return;
    }

    await agent.submitPrompt(trimmed);
  }

  // Read capabilities from the live (per-tab) provider, not the launch-time
  // prop, so the StatusBar context-window figure follows /provider switches.
  const capabilities = (refs.current?.provider ?? props.provider).getCapabilities(model);
  const inputAccentColor = permissionRequest ? 'yellow' : state === 'running' ? 'cyan' : 'green';
  const spinner = !permissionRequest && compacting
    ? {
        label: compacting.aggressive
          ? 'Compacting (aggressive)…'
          : 'Compacting context…',
        color: 'yellow',
      }
    : !permissionRequest && runningTool
    ? { label: `Running ${runningTool}…`, color: 'magenta' }
    : !permissionRequest && thinking
    ? { label: 'Thinking…', color: 'cyan' }
    : undefined;

  return (
    <Box flexDirection="column" display={isActive ? 'flex' : 'none'}>
      <ConversationDisplay
        items={items}
        streamingText={streamingText}
        pendingToolCall={pendingToolCall}
        spinner={spinner}
        useStatic={useStatic}
      />

      {permissionRequest && <PermissionPanel toolName={permissionRequest.toolName} />}

      {planMode && plannedCalls.length > 0 && state === 'idle' && (
        <PlanApprovalPanel count={plannedCalls.length} />
      )}

      {isActive && (
        <>
          <Separator />
          <Box paddingX={1} width="100%">
            <Text color={inputAccentColor} bold>{'> '}</Text>
            <TextInput value={input} onChange={setInput} onSubmit={(value) => { void handleSubmit(value); }} />
          </Box>
          <Separator />
        </>
      )}

      <StatusBar
        planMode={planMode}
        state={state}
        providerName={providerName}
        model={model}
        totalTokens={lastUsage?.totalTokens ?? estimatedTokens}
        tokensAreEstimate={lastUsage?.totalTokens === undefined && estimatedTokens !== undefined}
        contextWindow={capabilities.contextWindow}
        sessionTurns={sessionTurns}
        sessionToolCalls={sessionToolCalls}
        queueLength={queueLength}
        gitBranch={gitBranch}
        gitDirty={gitDirty}
        cwd={cwd}
      />
    </Box>
  );
}
