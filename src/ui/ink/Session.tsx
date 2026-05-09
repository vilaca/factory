import React, { useContext, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { TextInput } from './components/text-input.js';
import type { Provider } from '../../providers/types.js';
import type { AgentConfig } from '../../core/config/types.js';
import { ConversationDisplay } from './components/conversation-display.js';
import { Separator } from './components/separator.js';
import { StatusBar } from './components/status-bar.js';
import { PermissionPanel, parsePermissionInput } from './components/permission-panel.js';
import { PlanApprovalPanel, parsePlanInput } from './components/plan-approval-panel.js';
import {
  ProviderPicker,
  type ProviderEntry,
  type RecentPair,
} from './components/provider-picker.js';
import {
  RotationPromptPanel,
  parseRotationPromptInput,
} from './components/rotation-prompt-panel.js';
import type { RotationEntry } from '../../core/config/types.js';
import { updateGlobalConfig } from '../../core/config/index.js';
import { useAgentLoop, type AgentLoopApi } from './agent-loop/use-agent-loop.js';
import { dispatchSlashCommand } from './slash-commands.js';
import { TabsContext } from './tabs/TabsContext.js';
import { listProviderNames, createProvider } from '../../providers/registry.js';
import { getRecentSessions } from '../../core/session-log.js';
import { loadGlobalConfig } from '../../core/config/index.js';
import {
  addKey as addCredentialKey,
  deleteKey as deleteCredentialKey,
  keyFingerprint,
  listKeys,
} from '../../core/credentials.js';
import { descriptorByAlias, DESCRIPTORS, DESCRIPTOR_LIST } from '../../providers/descriptors.js';

// Providers whose auth flow is `simple-prompt` are the ones the picker
// drives multi-key selection for. Others (Copilot device flow, Google AI
// Studio OAuth, ollama/llamacpp no-auth) keep their single-credential
// path.
const SIMPLE_PROMPT_PROVIDERS = new Set(
  DESCRIPTOR_LIST.filter(d => d.authFlow === 'simple-prompt').map(d => d.name),
);

interface SessionProps {
  model: string;
  systemPrompt: string;
  provider: Provider;
  /** Id of the multi-key-store entry the launch provider was built with.
   *  Forwarded to useAgentLoop so the first turn's success is attributed
   *  to the right key in /keys. */
  keyId?: string;
  agentConfig?: AgentConfig;
  autoAllowTools?: string[];
  useTextToolFallback?: boolean;
  nativeToolSupport?: boolean;
  enableSessionLog?: boolean;
  strictLogging?: boolean;
  planMode?: boolean;
  enableCorrector?: boolean;
  mcpInfo?: { servers: string[]; toolCount: number };
  gitBranch?: string;
  gitDirty?: boolean | null;
  validationWarning?: string;
  isActive?: boolean;
  tabId?: number;
  tabLabel?: string;
}

// eslint-disable-next-line max-lines-per-function, complexity -- TODO(complexity): extract subviews (input bar, transcript, modals) into child components.
export function Session(props: SessionProps): React.ReactElement {
  const isActive = props.isActive ?? true;
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerRecents, setPickerRecents] = useState<RecentPair[]>([]);
  const [pickerRecentsLoading, setPickerRecentsLoading] = useState(false);
  const [showFullOutput, setShowFullOutput] = useState(false);
  // Two rotation-prompt-related pieces of state:
  // 1. `rotationPrompt` — the y/n panel above the input. Resolves the host's
  //    promptForFallback promise when the user answers.
  // 2. `fallbackPickerResolver` — set when the picker is open in rotation-
  //    fallback mode (after the user said yes). The picker's onCommit/
  //    onCancel route through this resolver instead of agent.setProviderByName.
  const [rotationPrompt, setRotationPrompt] = useState<{
    provider: string;
    model: string;
    reason: 'rate-limit' | 'auth';
    resolve: (decision: 'set-up' | 'decline') => void;
  } | null>(null);
  const [fallbackPickerResolver, setFallbackPickerResolver] = useState<
    ((entry: RotationEntry | null) => void) | null
  >(null);
  // Capture the latest value in a ref so the slash dispatch context's
  // toggle closure stays current without re-creating the dispatch arg
  // every render.
  const showFullOutputRef = useRef(showFullOutput);
  showFullOutputRef.current = showFullOutput;
  const agent = useAgentLoop(props);

  // Reload recents each time the picker opens so the freshest pairs are
  // offered. Cheap (~16 jsonl head reads) and avoids stale entries when the
  // user has been switching models in this session.
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
        });
      }
      setPickerRecents(pairs);
      setPickerRecentsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [pickerOpen]);

  // <Static> can only be used once we know we're staying single-tab. Once a
  // second tab has ever existed, switch to .map permanently — flipping back
  // to Static after the second tab closes would cause Ink to re-flush the
  // committed scrollback and double-print prior turns.
  const everMultiTabRef = useRef(false);
  const tabsCtx = useContext(TabsContext);
  if (tabsCtx && tabsCtx.tabs.length > 1) everMultiTabRef.current = true;
  const useStatic = !tabsCtx || (tabsCtx.tabs.length === 1 && !everMultiTabRef.current);

  // Register a stable getter with the tabs registry so tab-management
  // hotkeys and parent slash commands can read this session's current
  // AgentLoopApi without re-registering on every render.
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

  // Report whether this tab is blocked on user input so other tabs can
  // surface a "N waiting" hint in their prompt area.
  const isWaiting =
    !!agent.permissionRequest ||
    !!rotationPrompt ||
    (agent.planMode && agent.plannedCalls.length > 0 && agent.state === 'idle');
  useEffect(() => {
    if (!tabs || tabId === undefined) return;
    tabs.setWaiting(tabId, isWaiting);
  }, [tabs, tabId, isWaiting]);

  // Bridge the rotation runtime → React state. The rotation runtime calls
  // refs.current.requestFallback when both tiers exhaust; we drive the y/n
  // panel and (on yes) the picker in fallback mode, then resolve the
  // promise with the chosen entry (or null on cancel/decline).
  useEffect(() => {
    if (!agent.refs.current) return;
    agent.refs.current.requestFallback = async context => {
      if (!agent.refs.current) return null;
      if (agent.refs.current.rotationPromptDeclined) return null;

      // Step 1: y/n panel.
      const decision = await new Promise<'set-up' | 'decline'>(resolve => {
        setRotationPrompt({ ...context, resolve });
      });
      setRotationPrompt(null);
      if (decision === 'decline') {
        if (agent.refs.current) agent.refs.current.rotationPromptDeclined = true;
        return null;
      }

      // Step 2: picker in select-rotation-entry mode.
      const entry = await new Promise<RotationEntry | null>(resolve => {
        setFallbackPickerResolver(() => (chosen: RotationEntry | null) => {
          resolve(chosen);
        });
        setPickerOpen(true);
      });
      setFallbackPickerResolver(null);
      setPickerOpen(false);
      if (!entry) return null;

      // Step 3: persist as an override for the active tuple. Use
      // updateGlobalConfig so the read + mutate + write all happen under the
      // config mutex — without it, two tabs hitting rate limits at the same
      // time would each read the same baseline and one's append would clobber
      // the other.
      let added = false;
      try {
        const tupleKey = `${context.provider}:${context.model}`;
        await updateGlobalConfig(cfg => {
          const existing = cfg.agent?.rotation?.overrides?.[tupleKey] ?? [];
          const dup = existing.some(e => e.provider === entry.provider && e.model === entry.model);
          if (dup) return {};
          added = true;
          const nextOverrides = {
            ...(cfg.agent?.rotation?.overrides ?? {}),
            [tupleKey]: [...existing, entry],
          };
          return {
            agent: {
              ...cfg.agent,
              rotation: { ...cfg.agent?.rotation, overrides: nextOverrides },
            },
          };
        });
        if (added && agent.refs.current) {
          const existingRefs = agent.refs.current.rotation.overrides[tupleKey] ?? [];
          agent.refs.current.rotation.overrides[tupleKey] = [...existingRefs, entry];
        }
      } catch (err) {
        agent.addNotice('warn', `⚠ couldn't persist fallback: ${(err as Error).message}`);
      }
      return entry;
    };
  }, [agent]);

  const {
    items,
    state,
    thinking,
    compacting,
    runningTool,
    activity,
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
    emojiMode,
    userEmoji,
    refs,
    addNotice,
  } = agent;

  useInput(
    (inputChar, key) => {
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
      if (!pickerOpen && key.ctrl && inputChar === 'k') {
        if (refs.current) refs.current.rotationPromptDeclined = false;
        setPickerOpen(true);
        return;
      }
      if (pickerOpen) return;
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
    },
    { isActive },
  );

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
        const [cmd, ...rest] = trimmed.split(' ') as [string, ...string[]];
        refs.current?.sessionLogger?.logCommand(cmd, rest.join(' '));
        void dispatchSlashCommand(cmd, rest.join(' ').trim(), {
          agent,
          exit,
          tabs: tabs ?? undefined,
          openPicker: () => {
            if (refs.current) refs.current.rotationPromptDeclined = false;
            setPickerOpen(true);
          },
          toggleFullOutput: () => {
            const next = !showFullOutputRef.current;
            setShowFullOutput(next);
            return next;
          },
        });
        return;
      }
      const decision = parseRotationPromptInput(trimmed);
      rotationPrompt.resolve(decision);
      return;
    }

    if (state === 'running') {
      // Slash commands always fire immediately — they are UI/state ops,
      // not prompts for the agent. Only plain text gets queued.
      if (trimmed.startsWith('/')) {
        const [cmd, ...rest] = trimmed.split(' ') as [string, ...string[]];
        refs.current?.sessionLogger?.logCommand(cmd, rest.join(' '));
        void dispatchSlashCommand(cmd, rest.join(' ').trim(), {
          agent,
          exit,
          tabs: tabs ?? undefined,
          openPicker: () => {
            if (refs.current) refs.current.rotationPromptDeclined = false;
            setPickerOpen(true);
          },
          toggleFullOutput: () => {
            const next = !showFullOutputRef.current;
            setShowFullOutput(next);
            return next;
          },
        });
        return;
      }
      agent.queueInput(trimmed);
      return;
    }

    if (state === 'awaiting-permission') {
      // Slash commands are UI/state ops — never interpret them as a
      // permission decision (e.g. /clear shouldn't deny the pending tool).
      // Dispatch them and leave the permission still pending.
      if (trimmed.startsWith('/')) {
        const [cmd, ...rest] = trimmed.split(' ') as [string, ...string[]];
        refs.current?.sessionLogger?.logCommand(cmd, rest.join(' '));
        void dispatchSlashCommand(cmd, rest.join(' ').trim(), {
          agent,
          exit,
          tabs: tabs ?? undefined,
          openPicker: () => {
            if (refs.current) refs.current.rotationPromptDeclined = false;
            setPickerOpen(true);
          },
          toggleFullOutput: () => {
            const next = !showFullOutputRef.current;
            setShowFullOutput(next);
            return next;
          },
        });
        return;
      }
      const decision = parsePermissionInput(trimmed, permissionRequest?.toolName);
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
      const [cmd, ...rest] = trimmed.split(' ') as [string, ...string[]];
      refs.current.sessionLogger?.logCommand(cmd, rest.join(' '));
      const handled = await dispatchSlashCommand(cmd, rest.join(' ').trim(), {
        agent,
        exit,
        tabs: tabs ?? undefined,
        openPicker: () => {
          if (refs.current) refs.current.rotationPromptDeclined = false;
          setPickerOpen(true);
        },
        toggleFullOutput: () => {
          const next = !showFullOutputRef.current;
          setShowFullOutput(next);
          return next;
        },
      });
      if (handled) return;
    }

    await agent.submitPrompt(trimmed);
  }

  // Read capabilities from the live (per-tab) provider, not the launch-time
  // prop, so the StatusBar context-window figure follows /provider switches.
  const capabilities = (refs.current?.provider ?? props.provider).getCapabilities(model);
  const inputAccentColor = permissionRequest ? 'yellow' : state === 'running' ? 'cyan' : 'green';
  const spinner =
    !permissionRequest && compacting
      ? {
          label: compacting.aggressive ? 'Compacting (aggressive)…' : 'Compacting context…',
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
        showFullOutput={showFullOutput}
        emojiMode={emojiMode}
        userEmoji={userEmoji}
      />

      {permissionRequest && (
        <PermissionPanel toolName={permissionRequest.toolName} args={permissionRequest.args} />
      )}

      {planMode && plannedCalls.length > 0 && state === 'idle' && (
        <PlanApprovalPanel count={plannedCalls.length} />
      )}

      {pickerOpen && (
        <ProviderPicker
          providers={listProviderNames().map((name): ProviderEntry => {
            const desc = (DESCRIPTORS as Record<string, { label: string } | undefined>)[name];
            return { name, label: desc?.label ?? name };
          })}
          recents={pickerRecents}
          recentsLoading={pickerRecentsLoading}
          initialProvider={providerName}
          initialModel={model}
          multiKeyProviders={SIMPLE_PROMPT_PROVIDERS}
          loadModels={async (name, keyId) => {
            const cfg = keyId ? await loadGlobalConfig() : null;
            const descriptor = descriptorByAlias(name);
            const opts: Parameters<typeof createProvider>[1] = {};
            if (cfg && descriptor && keyId) {
              const list = listKeys(cfg, descriptor.name);
              const key = list.find(k => k.id === keyId);
              if (key) {
                opts.token = key.token;
                if (descriptor.needsAccountId && key.extras?.accountId) {
                  opts.accountId = key.extras.accountId;
                }
              }
            }
            const p = createProvider(name, opts);
            return p.listModels();
          }}
          loadKeysForProvider={async name => {
            const cfg = await loadGlobalConfig();
            const descriptor = descriptorByAlias(name);
            if (!descriptor) return [];
            const { listStatsForProvider } = await import('../../core/key-stats.js');
            const stats = await listStatsForProvider(descriptor.name);
            return listKeys(cfg, descriptor.name).map(k => {
              const s = stats[k.id];
              const ok = s?.successCount ?? 0;
              const warn = (s?.rateLimitCount ?? 0) + (s?.authErrorCount ?? 0);
              return {
                id: k.id,
                ...(k.label ? { label: k.label } : {}),
                fingerprint: keyFingerprint(k.token),
                ...(ok > 0 || warn > 0 ? { stats: { ok, warn } } : {}),
              };
            });
          }}
          validateKey={async (name, token) => {
            try {
              const descriptor = descriptorByAlias(name);
              const opts: Parameters<typeof createProvider>[1] = { token };
              if (descriptor?.needsAccountId) {
                // For workersAi we'd need the accountId too. The picker
                // doesn't ask for it yet — fall back to whatever's in
                // the config. Documented limitation.
                const cfg = await loadGlobalConfig();
                opts.accountId = cfg.workersAiAccountId;
              }
              const p = createProvider(name, opts);
              const models = await p.listModels();
              return { ok: true, models };
            } catch (err) {
              return { ok: false, error: (err as Error).message };
            }
          }}
          saveKey={async (name, token) => {
            const descriptor = descriptorByAlias(name);
            if (!descriptor) throw new Error(`Unknown provider: ${name}`);
            // workersAi accountId is not asked from the picker yet — pull
            // from existing config so the saved key still works.
            const cfg = descriptor.needsAccountId ? await loadGlobalConfig() : null;
            const extras =
              descriptor.needsAccountId && cfg?.workersAiAccountId
                ? { accountId: cfg.workersAiAccountId }
                : undefined;
            const entry = await addCredentialKey(descriptor.name, token, {
              ...(extras ? { extras } : {}),
            });
            return entry.id;
          }}
          deleteKey={async (name, keyId) => {
            const descriptor = descriptorByAlias(name);
            if (!descriptor) return;
            await deleteCredentialKey(descriptor.name, keyId);
          }}
          purpose={fallbackPickerResolver ? 'select-rotation-entry' : 'select-active'}
          onCancel={() => {
            if (fallbackPickerResolver) {
              fallbackPickerResolver(null);
            } else {
              setPickerOpen(false);
            }
          }}
          onCommit={(provider, chosenModel, keyId) => {
            if (fallbackPickerResolver) {
              fallbackPickerResolver({ provider, model: chosenModel });
            } else {
              setPickerOpen(false);
              void agent.setProviderByName(provider, chosenModel, keyId);
            }
          }}
        />
      )}

      {rotationPrompt && (
        <RotationPromptPanel
          provider={rotationPrompt.provider}
          model={rotationPrompt.model}
          reason={rotationPrompt.reason}
        />
      )}

      {isActive &&
        (() => {
          const totalWaiting = tabs ? tabs.waitingTabs.size : 0;
          const showWaiting = tabs && tabs.tabs.length > 1 && totalWaiting > 0;
          return (
            <>
              <Separator />
              <Box paddingX={1} width="100%">
                {props.tabLabel && <Text dimColor>{`[${props.tabLabel}]`}</Text>}
                {showWaiting && <Text color="yellow">{` (${totalWaiting} waiting)`}</Text>}
                {showFullOutput && <Text color="cyan">{' [full]'}</Text>}
                <Text color={inputAccentColor} bold>
                  {'> '}
                </Text>
                <TextInput
                  value={input}
                  onChange={setInput}
                  onSubmit={value => {
                    void handleSubmit(value);
                  }}
                  focus={!pickerOpen}
                />
              </Box>
              <Separator />
            </>
          );
        })()}

      <StatusBar
        planMode={planMode}
        state={state}
        activity={activity}
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
