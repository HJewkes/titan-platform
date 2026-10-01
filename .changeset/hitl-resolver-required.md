---
"@titan-design/hitl": minor
---

BREAKING: `GateStore.resolve` and `resolveGate` require a `GateResolver`, and `SqliteGateStore` refuses to construct over a table without the resolver column. The constructor throws `GateStoreSchemaOutdated` naming `gateResolverMigration` (with an empty `gateId`) instead of probing on each resolve. `migrate: true` now runs `gateResolverMigration` as version 2, beside versions 1 and 3. A resolve that reaches the SQLite trigger with no resolver throws `GateResolverRefused` with the reason "a resolver is required" instead of the raw SQLite error. The README's "Upgrading to 0.4" section lists the steps.
