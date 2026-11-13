---
"@titan-design/workflow": minor
---

Record a failed run's class as structured data. A failed step outcome and `StepFailedError` may carry `errorClass`, and `codeRoute`/`codeRecordRoute` take an `errorClass(error)` option that reads it off the thrown error. The runtime stores a rejected run's `errorClass` in the new `workflow_run.error_class` column, and `WorkflowRun.errorClass` reads it back. `workflowErrorClassMigration(n)` adds the column to an existing table and is safe to run twice. A table without the column keeps working and drops the class.
