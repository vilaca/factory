import type { GoogleAiStudioAuthMode } from '../../core/config/types.js';

export interface StartupCredentials {
  token?: string;
  accountId?: string;
  authMode?: GoogleAiStudioAuthMode;
  githubToken?: string;
  /** Id of the multi-key-store entry the token came from. Undefined when
   *  the token came from CLI override / env var / a non-store auth flow
   *  (Copilot, Google AI Studio OAuth). Carried so the agent loop can stamp
   *  per-key usage stats from the very first turn. */
  keyId?: string;
}

export interface AuthResult {
  token?: string;
  accountId?: string;
  authMode?: GoogleAiStudioAuthMode;
  githubToken?: string;
  shouldSave: boolean;
  /** Optional label captured at prompt time. Carried to `addKey` when
   *  `shouldSave` is true. Phase 1 always leaves this unset. */
  keyLabel?: string;
  /** Id of the multi-key-store entry the token came from. Undefined when
   *  no stored key matched (CLI/env/new prompt that hasn't been saved yet). */
  keyId?: string;
}
