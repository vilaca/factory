# providers — orientation

LLM provider adapters. If you're adding a provider, mapping a model to a capability tier, debugging streaming, or threading a new `ChatOptions` field through, you're in the right place.

## Public entry

- `createProvider(name, opts)` (`registry.ts`) — returns an `UnprimedProvider`. Must be paired with `prime(provider, model?)` (`prime.ts`) before any `getCapabilities` / `chat` / `chatNoStream` call. The split is enforced structurally by `UnprimedProvider` vs `Provider`; see also the `cf880ed` arch-test contract in `test/unit/arch/modularity.test.ts`.
- `DESCRIPTOR_LIST` and `getDescriptor(name)` (`registry.ts`) — `ProviderDescriptor` metadata used by the startup picker, auth flows, and config write paths. The only file the rest of the codebase looks at for "what providers exist".
- `Provider` interface (`types.ts`) — the streamed/non-stream chat surface every adapter implements. Every public field on `ChatOptions` is documented inline in `types.ts`; treat that file as the wire contract.
- `instrumentProviderRequests` (`instrument.ts`) — wraps a Provider so outbound calls log to the session log via `ModelRequestSource` bucketing (`main`, `compaction`, `corrector`, `subagent`).

## Files

- `types.ts` — `Provider`, `UnprimedProvider`, `ChatChunk`, `ChatOptions`, `TokenUsage`, `ProviderCapabilities`, `ModelRequestSource`. The cross-provider wire contract.
- `registry.ts` — `ProviderDescriptor` + `DESCRIPTOR_LIST` + `createProvider`. Adding a provider means touching this file (descriptor entry + factory branch + `StartupProviderName` union). All three are intentionally in one place so the picker, auth flow, and config write paths see one source of truth.
- `prime.ts` — single canonical bridge `UnprimedProvider → Provider`. UI / CLI sites that mint a provider MUST route through `prime()` (arch test enforces).
- `descriptors.ts` — per-provider picker/auth display metadata (re-exported via `registry.ts`).
- `auth-modes.ts` — Google AI Studio's auth-mode enum (kept here, not in `core/auth/`, because it's a provider-shape concern).
- `instrument.ts` — request-bucketing wrapper; the `_requestSource` per-call override lives on `ChatOptions` in `types.ts` to avoid an import cycle.
- `sampling-defaults.ts` — per-model recommended `topP`/`topK`/`temperature` table. Opt-in via `ChatOptions.recommendedSampling`.
- `shared.ts` — small utilities shared across non-OpenAI providers.
- `list-models-filter.ts` — common model-list filtering used by several adapters.
- `usage.ts` — `contextFillTokens` selector + `PromptTokensCarrier`. The status bar reads only this; the 44aeb26 arch contract forbids it from plucking `totalTokens` / `completionTokens` directly.

### Adapter shapes (three flavors)

1. **Flat file, delegates to `openai/`** — `cerebras.ts`, `groq.ts`, `mistral.ts`, `openrouter.ts`, `vercel.ts`, `llamacpp.ts`, `workersai.ts`. The simplest case. Template: `vercel.ts` or `groq.ts`. They construct a body via `openai/`'s `buildChatBody`, then call `streamOpenAiChat` / `sendOpenAiChat`.
2. **Folder with its own auth, still delegates to `openai/`** — `copilot/`, `googleaistudio/`. Auth flow lives next to the adapter; transport is still the shared adapter.
3. **Truly native** — `anthropic.ts`, `ollama.ts`, `cohere.ts`. These speak the vendor's own response shape and must not import from `openai/`.

`opencodezen/` is an OpenAI-compatible proxy that re-exposes Anthropic / Google through one endpoint; it's its own folder because the model catalog and routing logic are vendor-specific.

## What goes in `openai/`

`openai/` is the **internal** SSE/Responses adapter — not a registered provider. The `arch test "src/providers/openai/** is an internal adapter — no external importers"` forbids anything outside `src/providers/` from importing from it. Keep it that way: the streaming details, tool-call accumulation, and Responses-API plumbing should stay invisible to the agent loop.

## Adding a provider — checklist

1. New file (`providers/<name>.ts`) or folder (`providers/<name>/index.ts`).
2. Implement `UnprimedProvider` first (`listModels`, optionally `primeModelCache`) and `Provider` second.
3. Add an entry to `StartupProviderName` and `DESCRIPTOR_LIST` in `registry.ts`. Add the constructor branch in `createProvider`.
4. If it's OpenAI-compatible, delegate to `openai/` (`buildChatBody`, `streamOpenAiChat`, `sendOpenAiChat`).
5. Add a per-provider unit test under `test/unit/providers/<name>/`.
6. If the auth flow is novel, add it under `cli/auth/flows.ts` and reference it from the descriptor's `authFlow`.

## Invariants enforced in `test/unit/arch/modularity.test.ts`

- `providers/**` must not depend on `ui/`, `tools/`, `core/`, `mcp/`, or `cli/`. (`registry.ts` and `copilot/auth.ts` are the only carve-outs; keep new files out of those exception lists.)
- `providers/openai/**` has no importers outside `providers/`.
- Prime-before-use: any file that mints a provider AND reads its capabilities must also `prime()` / `listModels()` / `primeModelCache()`.
- No file may re-declare the `{ provider, model, keyId }` shape — use `ModelSelection` from `core/selection/types.ts`.

## Don't

- **Don't reach into `core/`, `tools/`, `ui/`, `mcp/`, or `cli/` from a provider file.** The arch test will fail. If you genuinely need a shared utility, it belongs in `utils/`.
- **Don't read `usage.totalTokens` or `usage.completionTokens` to gauge context fullness.** That's the 44aeb26 bug shape; use `contextFillTokens(usage)` in `usage.ts`.
- **Don't expand the `openai/` exception list in arch tests** to let UI or core code reach in. The whole point of the adapter being internal is that future SSE / stored-response changes are local.
- **Don't fold provider-specific picker logic into `descriptors.ts`** — it's metadata, not behavior. Picker behavior lives in `cli/picker.ts` / `cli/startup/menu.tsx` and reads descriptors.
