// Picker-commit dispatch, extracted from Session.tsx so the ordering
// invariant in 42853ba is unit-testable.
//
// Background: the provider-picker is hosted by <Session>, which gates the
// TextInput on `!pickerOpen`. If we close the picker (setPickerOpen(false))
// before `setProviderByName` resolves, the user's first post-pick keystroke
// can land while refs.current.{provider,model} still point at the *old*
// tuple — sending the next turn against the wrong provider. The fix is to
// chain setPickerOpen(false) onto the swap promise's `.finally`.
//
// The compaction- and fallback-picker paths are unaffected: they hand the
// chosen tuple back to a resolver and let the awaiting code path decide
// when to close.

export type CommitHandlerDeps = {
  /** Resolver for the compaction-model picker. Present when the picker was
   *  opened from the first-compaction prompt. */
  compactionPickerResolver?:
    | ((value: { providerName: string; model: string } | null) => void)
    | null;
  /** Resolver for the rotation-fallback picker. Present when the picker was
   *  opened from the rate-limit / auth fallback flow. */
  fallbackPickerResolver?:
    | ((value: { provider: string; model: string } | null) => void)
    | null;
  /** Drives the actual provider/model swap. The picker must remain open
   *  until this promise settles — closing earlier un-gates TextInput and
   *  races the first post-pick prompt against stale refs. */
  setProviderByName: (provider: string, model: string, keyId?: string) => Promise<void>;
  /** Toggles the picker's open/close state in Session. */
  setPickerOpen: (open: boolean) => void;
};

/** Build the picker's onCommit dispatcher. Returns the handler so the same
 *  factory can be tested in isolation: pass spies/mocks and assert the
 *  ordering of setProviderByName resolution vs. setPickerOpen(false). */
export function makePickerCommitHandler(
  deps: CommitHandlerDeps,
): (provider: string, chosenModel: string, keyId?: string) => void {
  return (provider, chosenModel, keyId) => {
    if (deps.compactionPickerResolver) {
      deps.compactionPickerResolver({ providerName: provider, model: chosenModel });
      return;
    }
    if (deps.fallbackPickerResolver) {
      deps.fallbackPickerResolver({ provider, model: chosenModel });
      return;
    }
    // Hold the picker open until the swap resolves. Closing first un-gates
    // TextInput (focus={!pickerOpen} in Session), so a fast-typing user
    // can submit a prompt before refs.current.{provider,model} are mutated
    // by setProviderByName — sending the first post-pick turn against the
    // old tuple. (fix 42853ba)
    void deps.setProviderByName(provider, chosenModel, keyId).finally(() => {
      deps.setPickerOpen(false);
    });
  };
}
