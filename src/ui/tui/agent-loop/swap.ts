// Provider/model swap helpers used by /provider and /model. Pulled out
// of useAgentLoop because the credential resolution + listModels +
// validation + ContextManager rebuild flow was the second-largest
// closure in the hook (~150 lines combined).

import type { MutableRefObject } from 'react';
import { ContextManager } from '../../../core/context/context-manager.js';
import { makeCompactionResolver } from './compaction-resolver.js';
import { validateModelToolSupport as defaultValidateModelToolSupport } from '../../../core/auth/model-validation.js';
import { loadGlobalConfig as defaultLoadGlobalConfig } from '../../../core/config/index.js';
import { getKey as defaultGetKey } from '../../../core/auth/credentials.js';
import {
  descriptorByAlias as defaultDescriptorByAlias,
  createProvider as defaultCreateProvider,
} from '../../../providers/registry.js';
import { errorMessage } from '../../../utils/errors.js';
import type { Provider } from '../../../providers/types.js';
import type { NoticeLevel, RunRefs, UseAgentLoopOptions } from './agent-loop-types.js';

/** Injectable seams for swapProvider. The defaults are the real registry /
 *  auth / config functions; tests substitute fakes to assert the
 *  createProvider → listModels → getCapabilities ordering invariant
 *  (see cf880ed) without standing up a real provider. */
export interface SwapProviderDeps {
  createProvider: typeof defaultCreateProvider;
  descriptorByAlias: typeof defaultDescriptorByAlias;
  loadGlobalConfig: typeof defaultLoadGlobalConfig;
  getKey: typeof defaultGetKey;
  validateModelToolSupport: typeof defaultValidateModelToolSupport;
}

const DEFAULT_DEPS: SwapProviderDeps = {
  createProvider: defaultCreateProvider,
  descriptorByAlias: defaultDescriptorByAlias,
  loadGlobalConfig: defaultLoadGlobalConfig,
  getKey: defaultGetKey,
  validateModelToolSupport: defaultValidateModelToolSupport,
};

export interface SwapContext {
  refs: MutableRefObject<RunRefs | null>;
  opts: UseAgentLoopOptions;
  addNotice: (level: NoticeLevel, text: string) => void;
  setModel: (m: string) => void;
  setProviderName: (n: string) => void;
  refreshTokenEstimate: () => void;
  composeSystemPrompt: () => string;
}

function rebuildContextManager(refs: NonNullable<RunRefs>, ctx: SwapContext): void {
  const caps = refs.provider.getCapabilities(refs.model);
  refs.contextManager = new ContextManager(
    refs.conversation,
    caps,
    {
      compactionThreshold: ctx.opts.agentConfig?.compactionThreshold,
      recencyWindow: ctx.opts.agentConfig?.recencyWindow,
      recencyTokens: ctx.opts.agentConfig?.recencyTokens,
      toolResultAgingTurns: ctx.opts.agentConfig?.toolResultAgingTurns,
    },
    makeCompactionResolver(ctx.refs),
  );
}

/** Swap to another model on the *current* provider. Honors `provider:model`
 *  syntax by delegating to swapProvider, so the user can switch both in one
 *  shot — useful so they don't end up on a provider whose default model
 *  isn't valid for it. */
export async function swapModel(
  name: string,
  ctx: SwapContext,
  deps: SwapProviderDeps = DEFAULT_DEPS,
): Promise<void> {
  const refs = ctx.refs.current;
  if (!refs) return;
  if (name.includes(':')) {
    const [providerPart, ...rest] = name.split(':');
    const modelPart = rest.join(':');
    // Only treat `<a>:<b>` as provider:model when the prefix is actually a
    // known provider alias. Otherwise `name` is a bare model whose tag
    // happens to contain a colon (Ollama style — e.g.
    // `deepseek-coder:33b-instruct`, `llama3.1:8b`) and belongs to the
    // current provider.
    if (providerPart && modelPart && deps.descriptorByAlias(providerPart)) {
      await swapProvider(providerPart, modelPart, undefined, ctx, deps);
      return;
    }
  }
  const provider = refs.provider;
  const validation = await deps.validateModelToolSupport(provider, name);
  if (validation.mode === 'unreachable') {
    ctx.addNotice('danger', validation.reason);
    return;
  }
  const prevFallback = refs.useTextToolFallback;
  refs.useTextToolFallback = validation.mode === 'fallback';
  refs.nativeToolSupport = validation.mode === 'native';
  if (validation.mode === 'fallback') {
    ctx.addNotice('warn', `⚠ ${validation.warning}`);
  }
  if (prevFallback !== refs.useTextToolFallback) {
    const sp = ctx.composeSystemPrompt();
    refs.conversation.updateSystemPrompt(sp);
    refs.sessionLogger?.logSystemPromptChange(`text-tool-fallback=${refs.useTextToolFallback}`);
    refs.sessionLogger?.logSystemPrompt(sp);
  }
  refs.sessionLogger?.logModelChange(refs.model, name);
  if (refs.model !== name) refs.responsesChain = undefined;
  refs.model = name;
  refs.primary = { provider: refs.provider.name, model: name };
  ctx.setModel(name);
  rebuildContextManager(refs, ctx);
  ctx.addNotice('info', `Model switched to ${name}`);
}

interface ResolvedProviderKey {
  createOpts: Parameters<typeof defaultCreateProvider>[1];
  resolvedKeyId: string | undefined;
}

/** Resolve credentials from the multi-key store. Without this the
 *  mid-session switch would call createProvider({}) and the provider
 *  would have to fall back to env vars, which most users don't have set
 *  (their token lives only in factory's config). With keyId, target
 *  that specific saved key; without, take the first key (matches the
 *  post-migration "default" entry). */
async function resolveProviderKey(
  alias: string,
  keyId: string | undefined,
  deps: SwapProviderDeps,
): Promise<ResolvedProviderKey> {
  const descriptor = deps.descriptorByAlias(alias);
  const createOpts: Parameters<typeof defaultCreateProvider>[1] = {};
  let resolvedKeyId = keyId;
  if (descriptor) {
    try {
      const cfg = await deps.loadGlobalConfig();
      const key = deps.getKey(cfg, descriptor.name, keyId);
      if (key) {
        createOpts.token = key.token;
        if (descriptor.needsAccountId && key.extras?.accountId) {
          createOpts.accountId = key.extras.accountId;
        }
        resolvedKeyId = key.id;
      }
    } catch {
      // Fall through with empty opts; provider may still pick up env vars.
    }
  }
  return { createOpts, resolvedKeyId };
}

/** Swap to another provider. We don't drive auth flows from inside the
 *  running CLI — providers fall back to env-var/config-file credentials.
 *  If the user hasn't authed yet, `createProvider` throws and we surface
 *  the hint. If a model is supplied, validate and apply it; otherwise
 *  pick the first model the new provider lists. */
export async function swapProvider(
  name: string,
  requestedModel: string | undefined,
  keyId: string | undefined,
  ctx: SwapContext,
  deps: SwapProviderDeps = DEFAULT_DEPS,
): Promise<void> {
  const refs = ctx.refs.current;
  if (!refs) return;
  const trimmed = name.trim();
  if (!trimmed) {
    ctx.addNotice('info', `Current provider: ${refs.provider.name}`);
    return;
  }
  if (trimmed === refs.provider.name && !keyId) {
    if (requestedModel) await swapModel(requestedModel, ctx, deps);
    else ctx.addNotice('info', `Already on ${trimmed}.`);
    return;
  }

  const { createOpts, resolvedKeyId } = await resolveProviderKey(trimmed, keyId, deps);

  let nextProvider: Provider;
  try {
    nextProvider = deps.createProvider(trimmed, createOpts);
  } catch (err) {
    ctx.addNotice('danger', `Cannot switch to ${trimmed}: ${errorMessage(err)}`);
    return;
  }

  // Prime the new provider's model-info cache before any getCapabilities
  // call (Anthropic's getCapabilities throws on a cache miss — see
  // src/providers/anthropic.ts:68). Run unconditionally even when
  // `requestedModel` is supplied: a fresh createProvider() instance has
  // its own empty cache, and the picker's separate instance doesn't
  // share state with the one we just minted.
  let availableModels: string[];
  try {
    availableModels = await nextProvider.listModels();
  } catch (err) {
    ctx.addNotice('danger', `Cannot list models for ${trimmed}: ${errorMessage(err)}`);
    return;
  }

  const nextModel: string | undefined = requestedModel ?? availableModels[0];
  if (!nextModel) {
    ctx.addNotice(
      'warn',
      `${trimmed} returned no models. Pass one explicitly: /provider ${trimmed} <model>`,
    );
    return;
  }

  const validation = await deps.validateModelToolSupport(nextProvider, nextModel);
  if (validation.mode === 'unreachable') {
    ctx.addNotice('danger', validation.reason);
    return;
  }

  refs.sessionLogger?.logModelChange(refs.model, nextModel, resolvedKeyId, nextProvider.name);
  // Provider tuple is changing; the chain is provider/model/key-scoped on
  // OpenAI's side. Drop it unconditionally — the new provider has no
  // server-side state to chain off.
  refs.responsesChain = undefined;
  // Loose invalidation of the compaction-model choice: only clear when
  // the *old* main provider matches the compaction target's provider.
  // If the user picked a cross-provider compaction target earlier (e.g.
  // Anthropic for compaction while running on Cerebras), and now swaps
  // the main provider (Cerebras → Groq), the Anthropic target is still
  // valid and shouldn't be re-prompted. Only when they leave the
  // provider their compaction target lives on do we drop the choice.
  if (refs.compactionTarget && refs.compactionTarget.providerName === refs.provider.name) {
    refs.compactionTarget = undefined;
  }
  refs.provider = nextProvider;
  refs.model = nextModel;
  refs.primary = { provider: nextProvider.name, model: nextModel };
  refs.activeKeyId = resolvedKeyId;
  refs.useTextToolFallback = validation.mode === 'fallback';
  refs.nativeToolSupport = validation.mode === 'native';
  ctx.setProviderName(nextProvider.name);
  ctx.setModel(nextModel);
  if (validation.mode === 'fallback') {
    ctx.addNotice('warn', `⚠ ${validation.warning}`);
  }
  rebuildContextManager(refs, ctx);
  ctx.refreshTokenEstimate();
  ctx.addNotice('info', `Provider → ${nextProvider.name}, model → ${nextModel}`);
}
