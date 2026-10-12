---
"@titan-design/workflow": minor
"@titan-design/factory": patch
---

Count runs per status without loading them (TP-2419). `WorkflowRunStore.countByStatus` and `WorkflowRuntime.count` read the status index alone. Serve's `/health` uses them instead of parsing every run's step results on each probe, which held the event loop for most of a second per request.
