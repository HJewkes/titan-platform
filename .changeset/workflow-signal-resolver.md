---
"@titan-design/workflow": minor
---

`WorkflowRuntime.signal(runId, stepId, payload, resolvedBy)` forwards an optional `GateResolver` to the gate store, which records it on the gate. A store that refuses the resolver throws `GateResolverRefused` from `signal`, and the run stays paused with its gate pending. Add `gateResolverMigration(n)` from `@titan-design/hitl/sqlite` to your migration list, then pass a resolver to every `signal`: after that migration, a signal with no resolver is refused by the database.
