---
"@titan-design/hitl": minor
---

BREAKING: `GateStore.resolve` and `resolveGate` require a `GateResolver`, and `SqliteGateStore` refuses to construct over a table without the resolver column. The constructor throws `GateStoreSchemaOutdated` naming `gateResolverMigration` (with an empty `gateId`) instead of probing on each resolve. `migrate: true` now runs `gateResolverMigration` as version 2, beside versions 1 and 3. Every store, memory and SQLite, refuses a resolve with no resolver with `GateResolverRefused` and the reason "a resolver is required", before the row is touched. The constructor names `gateMigration` instead when the table does not exist. The README's "Upgrading to 0.4" section lists the steps.
