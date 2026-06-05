import { runAgent } from '../../core/agent/run-agent.js';
import type { ToolLoopContext } from '../../core/agent/tool-calls/run-tool-calls.js';
import { runHarnessScopedInstructionReads } from '../../core/agent/tool-calls/harness-reads.js';
import type { HeadlessOptions } from './types.js';
import type { HeadlessRuntime } from './setup.js';
import { handleAgentEvent } from './event-handler.js';

export async function runHeadlessEventPump(
  userInput: string,
  options: HeadlessOptions,
  runtime: HeadlessRuntime,
): Promise<void> {
  const cwdRef = { current: runtime.cwd };

  const preTurnRefresh = await runtime.refreshScopedInstructions({
    toolName: 'TurnStart',
    args: {},
    cwd: cwdRef.current,
  });
  if (preTurnRefresh?.changed) {
    const scopedEvent = {
      type: 'scoped-project-instructions-updated' as const,
      files: preTurnRefresh.newFiles,
    };
    runtime.sessionLogger?.logAgentEvent(scopedEvent);
    handleAgentEvent(scopedEvent, runtime.state, runtime.diagnostics, runtime.cwd);

    if (preTurnRefresh.newFiles.length > 0) {
      const harnessCtx: ToolLoopContext = {
        conversation: runtime.conversation,
        permissions: runtime.permissions,
        toolRegistry: options.toolRegistry,
        signal: undefined,
        useUserResultFraming: !options.nativeToolSupport,
        planMode: options.planMode ?? false,
        enableCorrector: options.enableCorrector ?? false,
        fileCache: runtime.fileCache,
        provider: runtime.provider,
        model: options.model,
        userInput,
        cwdRef,
        pathPolicy: options.pathPolicy ?? {},
        envPolicy: options.envPolicy ?? {},
      };
      for await (const event of runHarnessScopedInstructionReads(
        preTurnRefresh.newFiles,
        harnessCtx,
      )) {
        runtime.sessionLogger?.logAgentEvent(event);
        handleAgentEvent(event, runtime.state, runtime.diagnostics, runtime.cwd);
      }
    }
  }

  for await (const event of runAgent(userInput, {
    provider: runtime.provider,
    model: options.model,
    conversation: runtime.conversation,
    permissions: runtime.permissions,
    toolRegistry: options.toolRegistry,
    contextManager: runtime.contextManager,
    useTextToolFallback: options.useTextToolFallback,
    nativeToolSupport: options.nativeToolSupport,
    planMode: options.planMode,
    enableCorrector: options.enableCorrector,
    experimental: {
      bashDedup: options.agentConfig?.experimental?.bashDedup,
      readCache: options.agentConfig?.experimental?.readCache,
      hooks: runtime.hooksEnabled,
    },
    fileCache: runtime.fileCache,
    // Headless doesn't mutate cwd mid-turn (no Bash `cd` round-tripping in
    // a one-shot run), so a static holder is sufficient. The TUI passes a
    // live mutable holder updated by Bash; headless does not.
    cwdRef,
    // Snapshot the policy at agent start so tools see it via ToolContext
    // and per-call hook fires use the same scrubbed env.
    pathPolicy: options.pathPolicy ?? {},
    envPolicy: options.envPolicy ?? {},
    hooksConfig: options.agentConfig?.hooks,
    onHookStderr: runtime.onHookStderr,
    onHookError: runtime.onHookError,
    responsesChainRef: runtime.responsesChainRef,
    onToolCallStart: runtime.refreshScopedInstructions,
    onSuccessfulToolCall: runtime.refreshScopedInstructions,
  })) {
    runtime.sessionLogger?.logAgentEvent(event);
    handleAgentEvent(event, runtime.state, runtime.diagnostics, runtime.cwd);
  }
}
