// Bridge ContextManager → React picker for the compaction-model choice.
//
// On the first compaction of a session, ContextManager calls
// refs.requestCompactionModel(). We open the existing provider/model
// picker in "select-rotation-entry" mode (same shape: skip the key
// stage, commit a (provider, model) tuple without touching the active
// session), and resolve the runtime's promise with the user's pick.
//
// Mirrors useRotationFallback's wiring style — same picker reuse, same
// resolver-set/clear pattern. Differs only in the resolved payload
// shape (compactionTarget vs RotationEntry) and that we don't persist
// to global config: the choice is session-scoped per the spec.

import { useEffect, useState } from 'react';
import type { AgentLoopApi } from '../agent-loop/use-agent-loop.js';

type CompactionPick = { providerName: string; model: string } | null;

interface UseCompactionPickerResult {
  /** When non-null, Session.tsx routes the picker's onCommit/onCancel to
   *  this resolver instead of the default "switch active session" flow.
   *  Cleared after the resolver fires. */
  compactionPickerResolver: ((pick: CompactionPick) => void) | null;
}

export function useCompactionPicker(
  agent: AgentLoopApi,
  setPickerOpen: (open: boolean) => void,
): UseCompactionPickerResult {
  const [compactionPickerResolver, setCompactionPickerResolver] = useState<
    ((pick: CompactionPick) => void) | null
  >(null);

  useEffect(() => {
    if (!agent.refs.current) return;
    agent.refs.current.requestCompactionModel = async () => {
      if (!agent.refs.current) return null;
      const pick = await new Promise<CompactionPick>(resolve => {
        setCompactionPickerResolver(() => (chosen: CompactionPick) => {
          resolve(chosen);
        });
        setPickerOpen(true);
      });
      setCompactionPickerResolver(null);
      setPickerOpen(false);
      return pick;
    };
  }, [agent, setPickerOpen]);

  return { compactionPickerResolver };
}
