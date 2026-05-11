import type React from 'react';
import { useInput } from 'ink';
import { parsePermissionInput } from '../components/permission-panel.js';
import { parsePlanInput } from '../components/plan-approval-panel.js';
import { parseRotationPromptInput } from '../components/rotation-prompt-panel.js';
import type { AgentLoopApi } from '../agent-loop/use-agent-loop.js';
import { dispatchSlashCommand } from '../slash/dispatch.js';
import type { TabsContextValue } from '../tabs/TabsContext.js';
import type { RotationPromptState } from './use-rotation-fallback.js';

interface UseSessionInputArgs {
  isActive: boolean;
  agent: AgentLoopApi;
  exit: () => void;
  tabs: TabsContextValue | null;
  input: string;
  setInput: (s: string) => void;
  pickerOpen: boolean;
  setPickerOpen: (b: boolean) => void;
  showFullOutputRef: React.MutableRefObject<boolean>;
  setShowFullOutput: (b: boolean) => void;
  rotationPrompt: RotationPromptState | null;
}

interface UseSessionInputResult {
  handleSubmit: (value: string) => Promise<void>;
}

/**
 * Owns the keyboard dispatch (`useInput`) and the four-way submit routing
 * (rotation prompt → running → awaiting-permission → idle), plus the plan-
 * mode shortcuts and slash command dispatcher.
 *
 * Returns `handleSubmit` for the TextInput's onSubmit. Registers `useInput`
 * as a side effect.
 */
export function useSessionInput(args: UseSessionInputArgs): UseSessionInputResult {
  const {
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
  } = args;

  const buildSlashCtx = (): Parameters<typeof dispatchSlashCommand>[2] => ({
    agent,
    exit,
    tabs: tabs ?? undefined,
    openPicker: () => {
      if (agent.refs.current) agent.refs.current.rotationPromptDeclined = false;
      setPickerOpen(true);
    },
    toggleFullOutput: () => {
      const next = !showFullOutputRef.current;
      setShowFullOutput(next);
      return next;
    },
  });

  const dispatchSlash = (trimmed: string): void => {
    const [cmd, ...rest] = trimmed.split(' ') as [string, ...string[]];
    agent.refs.current?.sessionLogger?.logCommand(cmd, rest.join(' '));
    void dispatchSlashCommand(cmd, rest.join(' ').trim(), buildSlashCtx());
  };

  useInput(
    (inputChar, key) => {
      if (key.ctrl && inputChar === 'c') {
        // While a turn is running, Ctrl+C aborts it without exiting — matches
        // shell muscle memory ("interrupt this command, stay in the prompt").
        // When idle, Ctrl+C exits the process.
        if (agent.state === 'running') {
          agent.addNotice('warn', '⏸ Ctrl+C — aborting agent run.');
          agent.abort();
          return;
        }
        agent.abort();
        exit();
        return;
      }
      if (!pickerOpen && key.ctrl && inputChar === 'k') {
        if (agent.refs.current) agent.refs.current.rotationPromptDeclined = false;
        setPickerOpen(true);
        return;
      }
      if (pickerOpen) return;
      if (key.escape && agent.state === 'running') {
        agent.addNotice('warn', '⏸ Esc — aborting agent run.');
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
    },
    { isActive },
  );

  async function processIdleInput(trimmed: string): Promise<void> {
    if (!agent.refs.current) return;

    // Plan-mode approval shortcuts when a plan is queued.
    if (agent.refs.current.planMode && agent.plannedCalls.length > 0) {
      const kind = parsePlanInput(trimmed);
      if (kind === 'approve') {
        agent.refs.current.sessionLogger?.logCommand('/approve', '');
        await agent.approvePlan();
        return;
      }
      if (kind === 'cancel') {
        agent.refs.current.sessionLogger?.logCommand('/cancel', '');
        agent.cancelPlan();
        agent.addNotice('info', 'Plan dropped. Still in plan mode.');
        return;
      }
      // 'revise' — non-slash input drops the plan and treats the input as a
      // follow-up prompt; slash commands fall through to the dispatcher below.
      if (!trimmed.startsWith('/')) {
        agent.cancelPlan();
        agent.addNotice('info', '(revising plan...)');
      }
    }

    if (trimmed.startsWith('/')) {
      const [cmd, ...rest] = trimmed.split(' ') as [string, ...string[]];
      agent.refs.current.sessionLogger?.logCommand(cmd, rest.join(' '));
      const handled = await dispatchSlashCommand(cmd, rest.join(' ').trim(), buildSlashCtx());
      if (handled) return;
    }

    await agent.submitPrompt(trimmed);
  }

  async function handleSubmit(value: string): Promise<void> {
    const trimmed = value.trim();
    setInput('');
    agent.recordHistory(trimmed);
    if (!trimmed) return;

    // The rotation prompt panel takes priority over every other input
    // route — y/n decides whether to keep the user staring at a 429 or
    // open the picker in fallback mode. Slash commands still pass through
    // (so the user can /q out without answering the prompt first).
    if (rotationPrompt) {
      if (trimmed.startsWith('/')) {
        dispatchSlash(trimmed);
        return;
      }
      const decision = parseRotationPromptInput(trimmed);
      rotationPrompt.resolve(decision);
      return;
    }

    if (agent.state === 'running') {
      // Slash commands always fire immediately — they are UI/state ops,
      // not prompts for the agent. Only plain text gets queued.
      if (trimmed.startsWith('/')) {
        dispatchSlash(trimmed);
        return;
      }
      agent.queueInput(trimmed);
      return;
    }

    if (agent.state === 'awaiting-permission') {
      // Slash commands are UI/state ops — never interpret them as a
      // permission decision (e.g. /clear shouldn't deny the pending tool).
      // Dispatch them and leave the permission still pending.
      if (trimmed.startsWith('/')) {
        dispatchSlash(trimmed);
        return;
      }
      // TODO: if the input doesn't parse as a valid permission response (y/n/
      // always/etc.), treat it as a new prompt rather than silently dropping it.
      // The user may be trying to redirect the agent mid-permission (e.g. "stop,
      // do X instead") — currently that text is lost and they have to retype it
      // after resolving the permission. One approach: auto-deny the pending
      // permission, then feed the input through processIdleInput as a fresh
      // prompt so the agent can act on the new direction immediately.
      const decision = parsePermissionInput(trimmed, agent.permissionRequest?.toolName);
      agent.respondToPermission(decision);
      return;
    }

    // Idle — process and drain queue.
    await processIdleInput(trimmed);
  }

  return { handleSubmit };
}
