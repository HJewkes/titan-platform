---
"@titan-design/workflow": minor
---

BREAKING: `WorkflowRuntime.signal(runId, stepId, payload, resolvedBy)` requires the resolver and drops the `{}` default on the payload, following hitl's required resolver. The gate store needs `gateResolverMigration` in the migration list, or its constructor throws `GateStoreSchemaOutdated`.
