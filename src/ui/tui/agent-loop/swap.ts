// Provider/model swap helpers used by /provider and /model. Pulled out
// of useAgentLoop because the credential resolution + listModels +
// validation + ContextManager rebuild flow was the second-largest
// closure in the hook (~150 lines combined).

import type { MutableRefObject } from 'react';
import { ContextManager } from '../../../core/context/context-manager.js';
import { validateModelToolSupport } from '../../../core/auth/model-validation.js';
import { loadGlobalConfig } from '../../../core/config/index.js';
import { getKey } from '../../../core/auth/credentials.js';
import { descriptorByAlias } from '../../../providers/descriptors.js';
import { createProvider } from '../../../providers/registry.js';
import type { Provider } from '../../../providers/types.js';
import type { NoticeLevel, RunRefs, UseAgentLoopOptions } from './agent-loop-types.js';

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
  refs.contextManager = new ContextManager(refs.conversation, caps, {
    compactionThreshold: ctx.opts.agentConfig?.compactionThreshold,
    recencyWindow: ctx.opts.agentConfig?.recencyWindow,
    recencyTokens: ctx.opts.agentConfig?.recencyTokens,
    toolResultAgingTurns: ctx.opts.agentConfig?.toolResultAgingTurns,
  });
}

/** Swap to another model on the *current* provider. Honors `provider:model`
 *  syntax by delegating to swapProvider, so the user can switch both in one
 *  shot — useful so they don't end up on a provider whose default model
 *  isn't valid for it. */
export async function swapModel(name: string, ctx: SwapContext): Promise<void> {
  const refs = ctx.refs.current;
  if (!refs) return;
  if (name.includes(':')) {
    const [providerPart, ...rest] = name.split(':');
    const modelPart = rest.join(':');
    if (!providerPart || !modelPart) {
      ctx.addNotice('warn', 'Usage: /model <name> or /model <provider>:<model>');
      return;
    }
    await swapProvider(providerPart, modelPart, undefined, ctx);
    return;
  }
  const provider = refs.provider;
  const validation = await validateModelToolSupport(provider, name);
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
  refs.model = name;
  refs.primary = { provider: refs.provider.name, model: name };
  ctx.setModel(name);
  rebuildContextManager(refs, ctx);
  ctx.addNotice('info', `Model switched to ${name}`);
}

interface ResolvedProviderKey {
  createOpts: Parameters<typeof createProvider>[1];
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
): Promise<ResolvedProviderKey> {
  const descriptor = descriptorByAlias(alias);
  const createOpts: Parameters<typeof createProvider>[1] = {};
  let resolvedKeyId = keyId;
  if (descriptor) {
    try {
      const cfg = await loadGlobalConfig();
      const key = getKey(cfg, descriptor.name, keyId);
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
): Promise<void> {
  const refs = ctx.refs.current;
  if (!refs) return;
  const trimmed = name.trim();
  if (!trimmed) {
    ctx.addNotice('info', `Current provider: ${refs.provider.name}`);
    return;
  }
  if (trimmed === refs.provider.name && !keyId) {
    if (requestedModel) await swapModel(requestedModel, ctx);
    else ctx.addNotice('info', `Already on ${trimmed}.`);
    return;
  }

  const { createOpts, resolvedKeyId } = await resolveProviderKey(trimmed, keyId);

  let nextProvider: Provider;
  try {
    nextProvider = createProvider(trimmed, createOpts);
  } catch (err) {
    ctx.addNotice('danger', `Cannot switch to ${trimmed}: ${(err as Error).message}`);
    return;
  }

  let nextModel: string | undefined = requestedModel;
  if (!nextModel) {
    try {
      const list = await nextProvider.listModels();
      nextModel = list[0];
    } catch (err) {
      ctx.addNotice('danger', `Cannot list models for ${trimmed}: ${(err as Error).message}`);
      return;
    }
    if (!nextModel) {
      ctx.addNotice(
        'warn',
        `${trimmed} returned no models. Pass one explicitly: /provider ${trimmed} <model>`,
      );
      return;
    }
  }

  const validation = await validateModelToolSupport(nextProvider, nextModel);
  if (validation.mode === 'unreachable') {
    ctx.addNotice('danger', validation.reason);
    return;
  }

  refs.sessionLogger?.logModelChange(refs.model, nextModel, resolvedKeyId);
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
