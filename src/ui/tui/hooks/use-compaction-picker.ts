// Bridge for the `/compaction-model` slash command. The TUI no longer
// auto-prompts on the first compaction — compaction defaults to the active
// provider+model. When the user wants a different summarizer they invoke
// `/compaction-model`, which calls `openCompactionPicker()` to open the
// existing provider/model picker in "select-rotation-entry" mode and
// resolves with the chosen tuple (or null on cancel).
//
// Session.tsx routes the picker's onCommit/onCancel to the active resolver
// (same dispatch shape as the rotation-fallback path) — see
// makePickerCommitHandler.

import { useCallback, useState } from 'react';

type CompactionPick = { providerName: string; model: string } | null;

interface UseCompactionPickerResult {
  /** When non-null, Session.tsx routes the picker's onCommit/onCancel to
   *  this resolver instead of the default "switch active session" flow.
   *  Cleared after the resolver fires. */
  compactionPickerResolver: ((pick: CompactionPick) => void) | null;
  /** Opens the picker and resolves to the user's pick (or null on cancel).
   *  Wired into the slash-dispatch context so `/compaction-model` can drive
   *  the picker without going through the agent-loop refs. */
  openCompactionPicker: () => Promise<CompactionPick>;
}

export function useCompactionPicker(
  setPickerOpen: (open: boolean) => void,
): UseCompactionPickerResult {
  const [compactionPickerResolver, setCompactionPickerResolver] = useState<
    ((pick: CompactionPick) => void) | null
  >(null);

  const openCompactionPicker = useCallback(
    () =>
      new Promise<CompactionPick>(resolve => {
        setCompactionPickerResolver(() => (chosen: CompactionPick) => {
          setCompactionPickerResolver(null);
          setPickerOpen(false);
          resolve(chosen);
        });
        setPickerOpen(true);
      }),
    [setPickerOpen],
  );

  return { compactionPickerResolver, openCompactionPicker };
}
