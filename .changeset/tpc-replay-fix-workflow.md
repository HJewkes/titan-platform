---
"@titan-design/workflow": minor
---

`runtime.cancel(runId, reason, { abandon: true })` finishes a run no runtime drives as cancelled without replaying it to settle its in-flight steps.
