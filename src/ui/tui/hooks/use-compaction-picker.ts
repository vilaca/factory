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
        // Capture the previous resolver inside the updater (pure: just a
        // read) and settle it *outside*, after we've installed the new
        // resolver and opened the picker. Calling the old resolver inside
        // the updater would nest its own setCompactionPickerResolver(null)
        // / setPickerOpen(false) calls and clobber the new resolver we
        // just returned — the picker would come up with no resolver bound
        // and the awaiting `/compaction-model` would never resolve.
        type Resolver = (pick: CompactionPick) => void;
        const prevBox: { current: Resolver | null } = { current: null };
        setCompactionPickerResolver((prev: Resolver | null) => {
          prevBox.current = prev;
          return (chosen: CompactionPick) => {
            setCompactionPickerResolver(null);
            setPickerOpen(false);
            resolve(chosen);
          };
        });
        setPickerOpen(true);
        // A second /compaction-model arrived while the picker was still
        // open on a prior invocation. Settle the in-flight promise with
        // null (treat as cancel) so its await site can unwind — otherwise
        // it leaks an unresolvable promise.
        prevBox.current?.(null);
      }),
    [setPickerOpen],
  );

  return { compactionPickerResolver, openCompactionPicker };
}
