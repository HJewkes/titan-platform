---
"@titan-design/workflow": minor
---

Add `runtime.annotate(runId, stepId, data)` and `WorkflowRunStore.annotate(id, key, result)`: record a step result on a run that already finished, once, without a fence. Unfinished runs and existing keys are refused with false.
