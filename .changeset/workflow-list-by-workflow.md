---
"@titan-design/workflow": minor
---

Add `WorkflowRunStore.listByWorkflow` and `WorkflowRuntime.listByWorkflow`, which load one workflow's runs of the asked statuses with a `WHERE workflow_name = ?` read instead of every run. New tables get a `(workflow_name, status)` index, and `workflowNameIndexMigration` adds it to an existing table.
