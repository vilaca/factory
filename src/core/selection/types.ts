// Canonical "what is the user pointing at?" record.
//
// Background: 550f093 fixed a bug where `keyId` was silently dropped at
// three intermediate hops between the picker and the agent loop. Each
// hop had its own parallel DTO that re-declared `{ provider, model }`
// (and sometimes `keyId?`); adding a new cross-cutting field meant
// editing every DTO, and any hop whose author forgot to add the field
// silently stripped it.
//
// This module owns the single record that all hops carry. Adding a new
// cross-cutting field (per-key budget, capability flags, BYOK source)
// is a one-line change here — and any hop that destructures incompletely
// or drops the field on assignment shows up as a TypeScript error, not
// a runtime bug.
//
// Naming: `ModelSelection` rather than `ProviderSelection` because the
// model is the most-specific identifier; the provider is implicit in
// the model in many providers' eyes (Anthropic's "claude-3-5-sonnet"
// doesn't need a separate provider field for routing, even though we
// carry one).

/** Picker-side error/throttle status badge. Lives here (rather than in
 *  session-log) because it's part of the selection record consumers
 *  pass around — keeping it in session-log would create a type-level
 *  cycle (session-log → selection → session-log) when RecentSession
 *  extends ModelSelection. */
export type SessionErrorStatus = 'throttle' | 'quota' | 'permission' | 'error';

/** A pointer at a model the user has selected or is about to select.
 *
 *  Required fields are the minimum every consumer needs. Optional
 *  fields are carried through opaquely — most consumers don't look at
 *  them, but the ones that do (status badges in the picker, keyId-aware
 *  routing in the rotation runtime) find them on the same record
 *  rather than reaching back to a separate registry. */
export interface ModelSelection {
  /** Canonical provider name (the key in PROVIDER_ALIASES values). */
  provider: string;
  /** Model id as the provider knows it. */
  model: string;
  /** Set when this selection is tied to a specific saved key. Optional
   *  because older session logs predate the multi-key store, and the
   *  fresh-provider startup path also has no specific key — both cases
   *  fall through to the provider's default key. Callers MUST NOT drop
   *  this field when forwarding a selection; threading it through is
   *  what 550f093 fixed. */
  keyId?: string;
  /** UI-only badge for picker rendering ("throttled", "quota",
   *  "permission", "error"). Optional. */
  status?: SessionErrorStatus;
}
