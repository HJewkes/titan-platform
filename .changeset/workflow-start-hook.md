---
"@titan-design/workflow": minor
---

`WorkflowRuntime.start` takes an optional `onStart(runId)` hook that runs inside the transaction that inserts the run. A hook that throws rolls the run back and nothing launches, so a caller's own row commits with the run or not at all.
