# core/config — orientation

Config file loading, merging, validation, and persistence. The on-disk shape is `~/.factory/config.json` (global) and `<repo>/.factory/config.json` (project); CLI flags override both.

## Public entry

- `loadConfig(cwd, cliOverrides)` (`index.ts`) — full load + merge + validate pipeline used by `src/index.ts`. Returns a validated `Config`. CLI overrides are applied last.
- `loadGlobalConfig()` (`index.ts`) — read-only access to the global config; cached in-process per `filePath`.
- `saveGlobalConfig(partial)` — **unconditional** partial update. Use only when the new value is independent of the prior value.
- `updateGlobalConfig(transform)` — **read-modify-write** under the in-process mutex. Use for anything that appends / increments / depends on what's already there (keys, rotation chains, experimental flags, …).
- `validateConfig(data, filePath)` (`validate.ts`) — zod-driven schema check with helpful path-pointed errors. Throws on invalid input.
- `mergeConfigs(...)` (`merge.ts`) — order-respecting merge (global → project → CLI).
- `types.ts` — `Config`, `AgentConfig`, `HooksConfig`, `RotationEntry`, `ProviderKey`, `BashRuleConfig`, `ExperimentalFlags`, `EXPERIMENTAL_FLAG_KEYS`.

## Files

- `index.ts` — load / merge / save / cache / mutex. The cache is keyed by `filePath` so an XDG env change in tests routes to a different entry.
- `merge.ts` — pure merge helper.
- `validate.ts` — zod schema, validators, error formatting.
- `types.ts` — TypeScript shapes. Adding a new config field starts here and propagates to `validate.ts`.

## RMW contract (f848472)

Two layers protect callers from racing on the on-disk config file:

1. **External callers.** Any file that imports both `loadGlobalConfig` AND `saveGlobalConfig` is almost certainly racing. The arch test in `test/unit/arch/modularity.test.ts` enforces this: pairing them in a single file fails, with the one allowlisted exception being `core/config/index.ts` itself (the migration code path).
2. **Internal writers.** `writeMergedConfig` (this file's only physical write helper) takes a `ConfigWriteCapability` parameter. The capability has a private constructor — only `withConfigLock` can mint one. **Adding a new in-module write helper that forgets the lock is a compile error**, not a runtime race. (Lift of the prior arch-tested rule to type-level enforcement — see Pattern 5 in the agent-arch sequence.)

The pattern to use externally:

```ts
// WRONG — two concurrent callers will clobber each other
const current = await loadGlobalConfig();
await saveGlobalConfig({ keys: [...(current.keys ?? []), newKey] });

// RIGHT — read, transform, write all under one mutex
await updateGlobalConfig(current => ({
  keys: [...(current.keys ?? []), newKey],
}));
```

The 8472 commit fixed a tab race where two `addKey()` calls clobbered each other's writes. `updateGlobalConfig` holds the mutex across the entire RMW.

## Caching

`loadGlobalConfig` caches the in-flight promise per resolved `filePath`. Steady-state callers (every agent turn re-reads via `run-loop.ts`) don't re-stat / re-parse / re-validate / re-import the migration code. Writes via `saveGlobalConfig` / `updateGlobalConfig` invalidate the cache.

## Migration

The legacy single-key credential format is migrated on first read. The migration is performed by `core/auth/credentials.ts:migrateLegacyKeys`, but `loadGlobalConfigUncached` invokes it inline and (best-effort) writes the migrated shape back. A failed write doesn't break the session — the migrated config is returned in memory and the next launch retries.

## Adding a config field

1. Extend `Config` (or one of its sub-interfaces) in `types.ts`.
2. Extend the zod schema in `validate.ts`. Default values go in the schema, not in caller code.
3. If the field is meant to be CLI-overridable, extend `loadConfig`'s CLI-overrides handling.
4. If the field is an experimental flag, add the key to `EXPERIMENTAL_FLAG_KEYS`. The `/exp` slash command lists/toggles them automatically; no further wiring needed.
5. Document the field's purpose inline in `types.ts` — every existing field has a JSDoc explaining what it gates.

## Invariants enforced in `test/unit/arch/modularity.test.ts`

- Files outside `core/config/index.ts` must not pair `loadGlobalConfig` with `saveGlobalConfig` (f848472 contract).
- No CLI parsing library may be imported anywhere in `src/**`. Config parsing here uses zod; CLI parsing in `cli/args.ts` is hand-rolled. Don't introduce one.

## Don't

- **Don't call `loadGlobalConfig` + `saveGlobalConfig` in the same call site.** _Enforced by arch test_ (f848472 contract). Use `updateGlobalConfig`.
- **Don't add a config field without a default in the zod schema.** _Folklore:_ no mechanical check. Defaults at the schema level keep every caller free of `?? defaultValue` sprinkles. Candidate for a schema-traversal test that asserts every leaf has a `.default(...)`.
- **Don't write outside `withConfigLock`.** _Enforced by type:_ every disk-mutating function in this file accepts a `ConfigWriteCapability` whose only minting site is `withConfigLock` — calling `writeMergedConfig` outside the lock is a compile error.

Note on migrations: a schema change that drops or renames a field needs a migration entry (see `core/auth/credentials.ts:migrateLegacyKeys` as the template). A "silent" rename — schema edited, no migration — leaves existing users with a config that fails validation on next launch. The migration code path itself is best-effort on write (so a read-only filesystem still boots), but the in-memory shape must always parse.
