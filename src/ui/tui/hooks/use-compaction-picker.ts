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

import { useCallback, useMemo, useRef, useState } from 'react';

export type CompactionPick = { providerName: string; model: string } | null;
export type CompactionResolver = (pick: CompactionPick) => void;

interface UseCompactionPickerResult {
  /** When non-null, Session.tsx routes the picker's onCommit/onCancel to
   *  this resolver instead of the default "switch active session" flow.
   *  Cleared after the resolver fires. */
  compactionPickerResolver: CompactionResolver | null;
  /** Opens the picker and resolves to the user's pick (or null on cancel).
   *  Wired into the slash-dispatch context so `/compaction-model` can drive
   *  the picker without going through the agent-loop refs. */
  openCompactionPicker: () => Promise<CompactionPick>;
}

/** Pure factory for the openCompactionPicker callback. Lives outside the
 *  hook so the double-invocation behavior (cancel the in-flight promise,
 *  install a fresh resolver, keep the picker open) can be tested without
 *  spinning up a React renderer.
 *
 *  Why pendingCancelRef and the public resolver are split: the second
 *  /compaction-model arrives while a prior call is still awaiting the
 *  picker. We need to settle the first promise so its slash handler can
 *  unwind, but the first call's public resolver also does state cleanup
 *  (resolver = null, picker = closed). Calling it synchronously would
 *  batch those writes with the new invocation's setCompactionPickerResolver
 *  / setPickerOpen calls — React's last-writer-wins on the batched queue
 *  would leave the new resolver as null and the picker closed. The cancel
 *  ref settles just the promise, no setState involved. */
export function makeOpenCompactionPicker(
  setCompactionPickerResolver: (resolver: CompactionResolver | null) => void,
  setPickerOpen: (open: boolean) => void,
  pendingCancelRef: { current: (() => void) | null },
): () => Promise<CompactionPick> {
  return () =>
    new Promise<CompactionPick>(resolve => {
      // Settle any in-flight promise BEFORE touching React state. This
      // only calls resolve(null) on the previous promise; it never
      // schedules a setState, so the state writes below cannot be
      // clobbered by a batched cleanup from the previous resolver.
      pendingCancelRef.current?.();
      pendingCancelRef.current = () => resolve(null);

      setCompactionPickerResolver((chosen: CompactionPick) => {
        pendingCancelRef.current = null;
        setCompactionPickerResolver(null);
        setPickerOpen(false);
        resolve(chosen);
      });
      setPickerOpen(true);
    });
}

export function useCompactionPicker(
  setPickerOpen: (open: boolean) => void,
): UseCompactionPickerResult {
  const [compactionPickerResolver, setCompactionPickerResolverRaw] =
    useState<CompactionResolver | null>(null);
  const pendingCancelRef = useRef<(() => void) | null>(null);

  // useState stores functions verbatim only when the value is passed via a
  // functional updater (otherwise React calls the function and stores its
  // return value). Wrap so the factory above can pass a plain resolver
  // without knowing about React's setState calling convention.
  const setCompactionPickerResolver = useCallback(
    (resolver: CompactionResolver | null) => setCompactionPickerResolverRaw(() => resolver),
    [],
  );

  const openCompactionPicker = useMemo(
    () => makeOpenCompactionPicker(setCompactionPickerResolver, setPickerOpen, pendingCancelRef),
    [setCompactionPickerResolver, setPickerOpen],
  );

  return { compactionPickerResolver, openCompactionPicker };
}
