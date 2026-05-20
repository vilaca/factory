import { useEffect, useState } from 'react';
import type { RotationEntry } from '../../../core/config/types.js';
import { tupleKey } from '../../../core/config/types.js';
import { updateGlobalConfig } from '../../../core/config/index.js';
import type { AgentLoopApi } from '../agent-loop/use-agent-loop.js';
import { errorMessage } from '../../../utils/errors.js';

export interface RotationPromptState {
  provider: string;
  model: string;
  reason: 'rate-limit' | 'auth';
  resolve: (decision: 'set-up' | 'decline') => void;
}

interface UseRotationFallbackResult {
  rotationPrompt: RotationPromptState | null;
  fallbackPickerResolver: ((entry: RotationEntry | null) => void) | null;
}

/**
 * Bridge the rotation runtime → React state. The rotation runtime calls
 * refs.current.requestFallback when both tier-1 (key) and tier-2 (chain)
 * exhaust; we drive the y/n panel and (on yes) the picker in fallback
 * mode, then resolve the runtime's promise with the chosen entry (or null
 * on decline / cancel).
 */
export function useRotationFallback(
  agent: AgentLoopApi,
  setPickerOpen: (open: boolean) => void,
): UseRotationFallbackResult {
  const [rotationPrompt, setRotationPrompt] = useState<RotationPromptState | null>(null);
  const [fallbackPickerResolver, setFallbackPickerResolver] = useState<
    ((entry: RotationEntry | null) => void) | null
  >(null);

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
        const key = tupleKey({ provider: context.provider, model: context.model });
        await updateGlobalConfig(cfg => {
          const existing = cfg.agent?.rotation?.overrides?.[key] ?? [];
          const dup = existing.some(e => e.provider === entry.provider && e.model === entry.model);
          if (dup) return {};
          added = true;
          const nextOverrides = {
            ...(cfg.agent?.rotation?.overrides ?? {}),
            [key]: [...existing, entry],
          };
          return {
            agent: {
              ...cfg.agent,
              rotation: { ...cfg.agent?.rotation, overrides: nextOverrides },
            },
          };
        });
        if (added && agent.refs.current) {
          const existingRefs = agent.refs.current.rotation.overrides[key] ?? [];
          agent.refs.current.rotation.overrides[key] = [...existingRefs, entry];
        }
      } catch (err) {
        agent.addNotice('warn', `⚠ couldn't persist fallback: ${errorMessage(err)}`);
      }
      return entry;
    };
  }, [agent, setPickerOpen]);

  return { rotationPrompt, fallbackPickerResolver };
}
