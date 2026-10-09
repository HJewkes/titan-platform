---
"@titan-design/factory": minor
---

`LandOptions.askApproval` asks a head-bound question in place of the `approve-merge` gate. `merge` approves only the head it was asked about, `abandon` stops the land, and `{ failed }` returns a `ci-failed` outcome with one `device-check` failing check whose `workflowRunId` is null, so it is never auto-rerun. Without the hook, land opens `approve-merge` as before.
