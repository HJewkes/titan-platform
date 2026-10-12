---
"@titan-design/workflow": patch
---

Document trace projection (TP-391 c): the README gains a "Trace projection" section covering `projectRunTrace`'s inputs, record kinds and order, the `titan.trace.gates` and `titan.trace.artifacts` data keys, and what is digested. A new test pins that a projection after rebuilding the runtime and SQLite stores from the same database is JSON-byte-identical, and that `workflowStepRequestKey` output matches `ATTEMPT_ID_PATTERN`.
