// Single source of truth for parsing a user-supplied model spec like
// `gpt-4o`, `anthropic:claude-3-5-sonnet`, or `deepseek-coder:33b-instruct`.
//
// Why this file exists (contract gap closed):
//   Before extraction, the colon-splitting rule lived inline in swap.ts.
//   The original bug (6287738) was that *every* colon-containing name was
//   treated as `provider:model`, breaking Ollama-style tagged names like
//   `deepseek-coder:33b-instruct`. The fix added a registry-aware guard,
//   but only at that one call site — any future caller would invent its
//   own splitter and rediscover the same bug.
//
// Contract:
//   - The parser is the ONLY way to interpret a user model string.
//   - The result is a tagged union; callers pattern-match instead of
//     re-parsing.
//   - "Is `x` a known provider alias?" is a question only the registry
//     can answer, so the resolver is injected — this keeps the parser
//     free of registry imports and trivially testable.

/** Resolves a candidate prefix to a provider descriptor, or undefined if
 *  the prefix is not a known alias. Matches the signature of
 *  `registry.descriptorByAlias` so callers can pass it directly.
 *  The parser only checks presence (truthy/falsy), so the return shape
 *  is left intentionally wide. */
export type DescriptorResolver = (alias: string) => object | undefined;

/** Parsed form of a user-supplied model spec.
 *
 *  - `bare-model`: no provider prefix — apply to the current provider.
 *    Includes the `<unknown>:<tag>` case (e.g. `deepseek-coder:33b-instruct`)
 *    and the `:<tag>` empty-prefix case; both belong on the current provider.
 *  - `provider-model`: `<known-alias>:<rest>` where the rest may itself
 *    contain colons (Ollama tag preserved, e.g. `ollama:llama3.1:8b`
 *    → provider=ollama, model=`llama3.1:8b`).
 */
export type ModelSpec =
  | { readonly kind: 'bare-model'; readonly model: string }
  | { readonly kind: 'provider-model'; readonly provider: string; readonly model: string };

/** Parse a `/model` or `/provider` argument into a ModelSpec.
 *
 *  Rules, in order:
 *   1. If `input` contains no `:`, it's a bare model.
 *   2. Split on the FIRST `:`. The right side may contain further colons
 *      (Ollama tags).
 *   3. If the left side is non-empty AND the resolver recognizes it as a
 *      provider alias, return `provider-model`. The remaining colons in
 *      the right side stay intact.
 *   4. Otherwise (empty prefix, or unknown prefix) the whole input is a
 *      bare model — colons and all.
 *
 *  Note: an empty `input` returns `{kind: 'bare-model', model: ''}`. The
 *  caller decides whether empty is meaningful (swap.ts treats it as
 *  "show current provider").
 */
export function parseModelSpec(input: string, resolve: DescriptorResolver): ModelSpec {
  if (!input.includes(':')) {
    return { kind: 'bare-model', model: input };
  }
  const idx = input.indexOf(':');
  const prefix = input.slice(0, idx);
  const rest = input.slice(idx + 1);
  if (prefix && rest && resolve(prefix)) {
    return { kind: 'provider-model', provider: prefix, model: rest };
  }
  return { kind: 'bare-model', model: input };
}
