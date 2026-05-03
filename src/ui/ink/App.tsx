import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { Provider } from '../../providers/types.js';
import type { AgentConfig } from '../../core/config-types.js';
import { ConversationDisplay } from './components/conversation-display.js';
import { StatusBar } from './components/status-bar.js';
import { PermissionPanel, parsePermissionInput } from './components/permission-panel.js';
import { PlanApprovalPanel, parsePlanInput } from './components/plan-approval-panel.js';
import { useAgentLoop } from './use-agent-loop.js';
import { dispatchSlashCommand } from './slash-commands.js';

export interface AppProps {
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
}

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const agent = useAgentLoop(props);

  const {
    items,
    state,
    thinking,
    compacting,
    runningTool,
    streamingText,
    permissionRequest,
    plannedCalls,
    planMode,
    model,
    sessionTurns,
    sessionToolCalls,
    lastUsage,
    estimatedTokens,
    queueLength,
    gitBranch,
    gitDirty,
    refs,
    addNotice,
  } = agent;

  // Keyboard: Esc aborts; Ctrl+C exits (raw mode swallows SIGINT, so we
  // handle it explicitly); Up/Down navigates input history.
  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') {
      // Cancel any in-flight stream before exiting — otherwise the open HTTP
      // socket keeps Node alive (and Ollama keeps generating on the GPU).
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
  });

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
        void dispatchSlashCommand(cmd, rest.join(' ').trim(), { agent, exit });
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
      const handled = await dispatchSlashCommand(cmd, rest.join(' ').trim(), { agent, exit });
      if (handled) return;
    }

    await agent.submitPrompt(trimmed);
  }

  // Render
  const capabilities = props.provider.getCapabilities(model);
  const inputBorderColor = permissionRequest ? 'yellow' : state === 'running' ? 'cyan' : 'green';
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
    <Box flexDirection="column">
      <ConversationDisplay items={items} streamingText={streamingText} spinner={spinner} />

      {permissionRequest && <PermissionPanel toolName={permissionRequest.toolName} />}

      {planMode && plannedCalls.length > 0 && state === 'idle' && (
        <PlanApprovalPanel count={plannedCalls.length} />
      )}

      <Box borderStyle="round" borderColor={inputBorderColor} paddingX={1}>
        <Text color={inputBorderColor} bold>{'> '}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      </Box>

      <StatusBar
        planMode={planMode}
        state={state}
        providerName={props.provider.name}
        model={model}
        totalTokens={lastUsage?.totalTokens ?? estimatedTokens}
        tokensAreEstimate={lastUsage?.totalTokens === undefined && estimatedTokens !== undefined}
        contextWindow={capabilities.contextWindow}
        sessionTurns={sessionTurns}
        sessionToolCalls={sessionToolCalls}
        queueLength={queueLength}
        gitBranch={gitBranch}
        gitDirty={gitDirty}
      />
    </Box>
  );
}
