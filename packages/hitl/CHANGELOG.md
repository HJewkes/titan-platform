# @titan-design/hitl

## 0.4.1

### Patch Changes

- Updated dependencies [32adb30]
  - @titan-design/authority@0.3.0

## 0.4.0

### Minor Changes

- 9bef02d: A gate can carry the authority rule that opened it (`GateInput.rule`, `GateRecord.rule`). A rule-bound gate refuses a resolver whose class the rule does not name, or no resolver, with `GateResolverRefused`. `gateRuleMigration(n)` adds the SQLite `rule` column and a trigger that refuses the same write from raw SQL; `migrate: true` runs it as version 3. A rule-bound gate resolves on SQLite only once `gateResolverMigration` has also run. New exports: `GateRule`, `GateRuleInvalid`, `ruleResolverRefusal`, and `gateRuleMigration` from `/sqlite`.
- 9c0aa55: BREAKING: `GateStore.resolve` and `resolveGate` require a `GateResolver`, and `SqliteGateStore` refuses to construct over a table without the resolver column. The constructor throws `GateStoreSchemaOutdated` naming `gateResolverMigration` (with an empty `gateId`) instead of probing on each resolve. `migrate: true` now runs `gateResolverMigration` as version 2, beside versions 1 and 3. Every store, memory and SQLite, refuses a resolve with no resolver with `GateResolverRefused` and the reason "a resolver is required", before the row is touched. The constructor names `gateMigration` instead when the table does not exist. The README's "Upgrading to 0.4" section lists the steps.

### Patch Changes

- 9ac05b5: Tests and README now pin the rule-bound insert guard against raw SQL. A rule-less `INSERT ON CONFLICT DO UPDATE`, `DO NOTHING`, `INSERT OR IGNORE` or plain duplicate insert onto a pending rule-bound id aborts with the guard message, because the trigger fires before conflict handling. A raw `REPLACE` of a cancelled rule-bound row still yields a pending rule-less row; the README states that is outside the store API. No behaviour change.
- 8b0e7ed: `gateRuleMigration` now installs an INSERT twin of the rule trigger, so `REPLACE INTO` and DELETE then INSERT of a rule-bound gate can no longer resolve it with a class outside the rule. A rule-bound row also refuses a status outside `pending`, `resolved`, `cancelled` and `expired` on insert and update, so `RESOLVED` cannot slip past the resolver check. Re-running the migration replaces both triggers in place.
- 50a7550: `gateRuleMigration` now installs a BEFORE INSERT guard, so `REPLACE INTO` and `INSERT OR REPLACE` of a pending rule-bound gate id with a different or NULL rule abort instead of leaving a rule-less resolved row. It needs no `recursive_triggers` pragma. An UPDATE that adds a rule to a rule-less row aborts, and is pinned by a test. Re-running the migration still leaves one trigger per event.
- Updated dependencies [6e848b7]
  - @titan-design/authority@0.2.1

## 0.3.1

### Patch Changes

- Updated dependencies [be51d27]
  - @titan-design/authority@0.2.0

## 0.3.0

### Minor Changes

- 629cdd9: Record who resolved a gate. `resolve` and `resolveGate` take an optional `GateResolver`, stored as `GateRecord.resolvedBy` by both stores. Every store refuses a resolver outside authority's `RESOLVER_CLASSES` with `GateResolverRefused`, and a new `authorize` store option can refuse more. `gateResolverMigration(n)` adds the `resolved_by` column and a trigger that refuses a resolve naming no resolver; a store on an unmigrated table throws `GateStoreSchemaOutdated` when given a resolver. Existing callers that pass no resolver and do not run the new migration behave as before. hitl now depends on `@titan-design/authority`.

### Patch Changes

- Updated dependencies [1b02a8b]
  - @titan-design/authority@0.1.0

## 0.2.1

### Patch Changes

- Updated dependencies [825b8b2]
  - @titan-design/store-sqlite@0.3.1

## 0.2.0

### Minor Changes

- cf764b6: Breaking: the root entry no longer exports `SqliteGateStore`, `gateMigration`, or `gateTableDdl` — it is now runtime-neutral (no `node:*` import, no `better-sqlite3`), so it loads in a Cloudflare Workers isolate. `randomUUID` now comes from `globalThis.crypto` instead of `node:crypto`.

  Migration: change `import { SqliteGateStore, gateMigration } from "@titan-design/hitl"` to `import { SqliteGateStore, gateMigration } from "@titan-design/hitl/sqlite"`. Everything else (`openGate`, `resolveGate`, `GateStore`, `MemoryGateStore`) is unchanged at the root.

### Patch Changes

- Updated dependencies [e204012]
  - @titan-design/store-sqlite@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies [11b94a2]
  - @titan-design/store-sqlite@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [8153dd8]
  - @titan-design/store-sqlite@0.2.0

## 0.1.0

### Minor Changes

- aa9a762: Build the headless-agent and human-in-the-loop tiers.

  `@titan-design/agent` wraps the Claude Agent SDK's `query()` with the invariants the
  brain spike proved out: an environment scrub (anti-nesting vars, non-allowlisted
  `CLAUDE_CODE_*`, proxy leakage, and metered credentials unless `allowApiKeyBilling`),
  required `maxTurns`/`maxBudgetUsd` because the SDK defaults both to unlimited, an
  `apiKeySource` blacklist checked on the first `system/init`, an inactivity watchdog and
  external `AbortSignal` that both end through the SDK's abort path, structured output via
  `outputFormat: json_schema` re-validated with the caller's zod schema, and a failure
  taxonomy (`rate_limited | budget_exceeded | schema_invalid | max_turns | refusal |
auth_misconfigured | runtime_error | aborted | inactivity_timeout`) in place of thrown
  errors.

  `@titan-design/hitl` makes a paused task a row rather than a promise: `openGate` writes a
  gate any process can answer by id, `wait` polls until someone calls `resolveGate`, and the
  schema travels with the row as JSON Schema so the resolver can reject a bad payload
  without holding the original zod schema. `MemoryGateStore` and a `SqliteGateStore` over
  `@titan-design/store-sqlite` share one settle implementation and one behaviour suite.

### Patch Changes

- Updated dependencies [aa5f694]
  - @titan-design/store-sqlite@0.1.0
