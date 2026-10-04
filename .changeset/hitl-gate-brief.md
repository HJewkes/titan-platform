---
"@titan-design/hitl": minor
---

Add gate briefs. `GateInput`, `GateRecord` and `openGate` gain optional `summary`, `evidenceRef` and `questions` (1-4 questions, 2-4 options each, labels up to 75 characters, at most one recommended option per question). A store built with `requireBrief: true` refuses `create` without a summary and an evidence pointer; a present brief field is always checked. A bad brief throws `GateBriefInvalid` and writes no row. `snapshotBrief` exposes the check. On SQLite, `gateBriefMigration(n)` adds the `summary`, `evidence_ref` and `questions` columns; `migrate: true` stores run it as version 4. A store whose table lacks them refuses a brief with `GateStoreSchemaOutdated`. Stores without `requireBrief` behave as before.
