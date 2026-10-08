---
"@titan-design/hitl": minor
---

`MemoryGateStore` now clones a gate's `payload` and `schema` when it stores or returns one, so mutating a resolved payload no longer rewrites the stored gate. `create` refuses an unparseable `expiresAt` (a string or an invalid `Date`) with the new exported `GateExpiryInvalid` and stores nothing, in both stores; a valid string is normalised to ISO-8601 with milliseconds. The `migrate: false` docs now list `gateRuleMigration` and `gateBriefMigration` beside the other two.
