---
"@titan-design/workflow": patch
---

`WorkflowRuntime.cancel(..., { abandon: true })` now emits a `step_abandoned` event for each in-flight step it drops, before `workflow_cancelled`, so the dropped steps stay on record once the run's `activeSteps` are cleared.
