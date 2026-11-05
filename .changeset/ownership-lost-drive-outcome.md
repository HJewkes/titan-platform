---
"@titan-design/workflow": minor
"@titan-design/factory": patch
---

Add `WorkflowRuntime.isLive(runId)`, which is true while this runtime still drives the run. A run this process drives in-process, under `titan-factory autoresearch start` or `resume`, now stops being waited on once the runtime has dropped it unfinished, for example after its lease lapsed. The CLI then exits nonzero with a single line that names the run as resumable and gives the resume command. The resume report lists such runs under `lost`. Serve's adoption sweep is unchanged.
