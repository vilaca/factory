// Shared test helpers for run-tool-calls / run-tool-calls-execute. Filename
// does not match *.test.ts so the runner glob ignores it.

import type {
  Provider,
  ChatChunk,
  ProviderCapabilities,
  ToolCallMessage,
} from '../../../../../src/providers/types.js';
import type {
  BashToolHandler,
  BashToolResult,
  ToolHandler,
  ToolResult,
  ToolCategory,
} from '../../../../../src/tools/types.js';
import type { AgentEvent, PermissionDecision } from '../../../../../src/core/agent/types.js';
import { ToolRegistry } from '../../../../../src/tools/registry.js';
import { Conversation } from '../../../../../src/core/context/conversation.js';
import { PermissionManager } from '../../../../../src/security/permissions.js';
import { RecoveryState } from '../../../../../src/core/agent/recovery-state.js';
import type { StepEnforcer } from '../../../../../src/core/agent/step-enforcer.js';
import type { ToolLoopContext } from '../../../../../src/core/agent/tool-calls/run-tool-calls.js';

export interface FakeToolOptions {
  name: string;
  category?: ToolCategory;
  execute?: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
}

export interface FakeBashToolOptions {
  name?: string;
  execute?: (args: Record<string, unknown>) => Promise<BashToolResult> | BashToolResult;
}

export function fakeTool(
  opts: FakeToolOptions,
): ToolHandler & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const handler: ToolHandler = {
    name: opts.name,
    description: 'fake',
    category: opts.category ?? 'read-only',
    definition: {
      type: 'function',
      function: { name: opts.name, description: 'fake', parameters: {} },
    },
    async execute(args) {
      calls.push(args);
      const r = await (opts.execute?.(args) ?? { success: true, output: 'ok' });
      return r;
    },
  };
  return Object.assign(handler, { calls });
}

/** Construct a Bash-shaped fake handler whose `execute` may return
 *  `cwdAfter`. Needed because the `cwdAfter` field is forbidden by the
 *  type system on standard `ToolHandler` and only `BashToolHandler` can
 *  satisfy the access path in `run-tool-calls-execute.ts`. */
export function fakeBashTool(
  opts: FakeBashToolOptions = {},
): BashToolHandler & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const handler: BashToolHandler = {
    kind: 'bash',
    name: opts.name ?? 'Bash',
    description: 'fake',
    category: 'execute',
    definition: {
      type: 'function',
      function: { name: opts.name ?? 'Bash', description: 'fake', parameters: {} },
    },
    async execute(args) {
      calls.push(args);
      const r = await (opts.execute?.(args) ?? { success: true, output: 'ok' });
      return r;
    },
  };
  return Object.assign(handler, { calls });
}

export function makeRegistry(tools: ToolHandler[]): ToolRegistry {
  const registry = new ToolRegistry({ empty: true });
  for (const t of tools) registry.register(t);
  return registry;
}

export interface ContextOverrides {
  conversation?: Conversation;
  permissions?: PermissionManager;
  toolRegistry?: ToolRegistry;
  signal?: AbortSignal;
  useUserResultFraming?: boolean;
  planMode?: boolean;
  enableCorrector?: boolean;
  bashDedup?: ToolLoopContext['bashDedup'];
  fileCache?: ToolLoopContext['fileCache'];
  provider?: Provider;
  model?: string;
  userInput?: string;
  cwdRef?: { current: string };
  hooksEnabled?: boolean;
  hooksConfig?: ToolLoopContext['hooksConfig'];
  onHookStderr?: ToolLoopContext['onHookStderr'];
  onHookError?: ToolLoopContext['onHookError'];
  stepEnforcer?: StepEnforcer;
}

export function makeCtx(overrides: ContextOverrides = {}): ToolLoopContext {
  return {
    conversation: overrides.conversation ?? new Conversation('sys'),
    permissions: overrides.permissions ?? new PermissionManager(),
    toolRegistry: overrides.toolRegistry ?? new ToolRegistry({ empty: true }),
    signal: overrides.signal,
    useUserResultFraming: overrides.useUserResultFraming ?? false,
    planMode: overrides.planMode ?? false,
    enableCorrector: overrides.enableCorrector ?? false,
    bashDedup: overrides.bashDedup,
    fileCache: overrides.fileCache,
    provider: overrides.provider ?? makeProvider(),
    model: overrides.model ?? 'mock-model',
    userInput: overrides.userInput ?? '',
    cwdRef: overrides.cwdRef,
    hooksEnabled: overrides.hooksEnabled ?? false,
    hooksConfig: overrides.hooksConfig,
    onHookStderr: overrides.onHookStderr,
    onHookError: overrides.onHookError,
    ...(overrides.stepEnforcer ? { stepEnforcer: overrides.stepEnforcer } : {}),
  };
}

export interface ProviderOptions {
  /** Scripted chatNoStream return values (for corrector tests). */
  noStreamResponses?: string[];
  modelTier?: 'strong' | 'medium' | 'weak';
  name?: string;
  /** Records the model id passed to chatNoStream — lets tests assert weak-tier routing. */
  modelLog?: string[];
}

export function makeProvider(opts: ProviderOptions = {}): Provider {
  const queue = [...(opts.noStreamResponses ?? [])];
  return {
    name: opts.name ?? 'anthropic',
    async listModels() {
      return ['mock-model'];
    },
    getCapabilities(): ProviderCapabilities {
      return {
        contextWindow: 8192,
        maxOutputTokens: 4096,
        toolSupport: 'native',
        parallelToolCalls: false,
        streaming: true,
        tokenCounting: 'estimated',
        modelTier: opts.modelTier ?? 'medium',
      };
    },
    async *chat(): AsyncGenerator<ChatChunk> {
      yield { done: true };
    },
    async chatNoStream(model): Promise<ChatChunk> {
      opts.modelLog?.push(model);
      const next = queue.shift();
      return { content: next ?? '', done: true };
    },
  };
}

export interface CollectOptions {
  onPermission?: (toolName: string) => PermissionDecision;
}

/** Drive an AgentEvent generator to completion, auto-responding to permission
 *  requests. Returns events plus the generator's return value (e.g. the
 *  `{ deniedCount }` from runToolCalls). */
export async function collect<R = void>(
  gen: AsyncGenerator<AgentEvent, R>,
  opts: CollectOptions = {},
): Promise<{ events: AgentEvent[]; result: R }> {
  const events: AgentEvent[] = [];
  let result: R | undefined;
  while (true) {
    const r = await gen.next();
    if (r.done) {
      result = r.value as R;
      break;
    }
    events.push(r.value);
    if (r.value.type === 'permission-request') {
      const decision = opts.onPermission?.(r.value.toolName) ?? 'allow';
      r.value.respond(decision);
    }
  }
  return { events, result: result as R };
}

export function makeRecovery(maxCorrections = 3): RecoveryState {
  return new RecoveryState(2, maxCorrections);
}

export function callOf(
  name: string,
  args: Record<string, unknown> = {},
  id = 'tc-1',
): ToolCallMessage {
  return { id, function: { name, arguments: args } };
}
