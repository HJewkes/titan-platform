---
"@titan-design/factory": patch
"@titan-design/workflow": minor
"@titan-design/github": patch
---

Shepherd treats an `update-branch` HTTP 422 "merge conflict between base and head" as a conflict instead of failing the run: it wakes the fixer, and opens `approve-merge` only if the conflict survives one wake. A run that reads a new head cancels its own pending `approve-merge` and `sh-sent-back` gates for an older head. `WorkflowContext` gains `expireGates(reason, isStale)`, and the fake GitHub gains `updateBranchConflict`.
