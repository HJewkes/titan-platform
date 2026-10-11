---
"@titan-design/session-graph": minor
---

`session_origin` stores an experiment arm and follow-up counts: `ResolvedOrigin` gains `experimentId`, `experimentArm`, `predecessor` and `followupKinds`, written to new columns by the `origin experiment arm` migration (`ORIGIN_EXPERIMENT_MIGRATION_NAME`). An arm table for one experiment is one query over `session_origin`.
