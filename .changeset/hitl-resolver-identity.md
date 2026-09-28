---
"@titan-design/hitl": minor
---

Record who resolved a gate. `resolve` and `resolveGate` take an optional `GateResolver`, stored as `GateRecord.resolvedBy` by both stores. Every store refuses a resolver outside authority's `RESOLVER_CLASSES` with `GateResolverRefused`, and a new `authorize` store option can refuse more. `gateResolverMigration(n)` adds the `resolved_by` column and a trigger that refuses a resolve naming no resolver; a store on an unmigrated table throws `GateStoreSchemaOutdated` when given a resolver. Existing callers that pass no resolver and do not run the new migration behave as before. hitl now depends on `@titan-design/authority`.
