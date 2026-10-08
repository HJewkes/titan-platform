---
"@titan-design/workflow": minor
---

Add `WorkflowContext.resumedGate()`: the step a resumed run was paused on and has not reached again, so a workflow that changed since the record can tell a still-pending gate from live code.
