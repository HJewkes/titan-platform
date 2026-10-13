---
"@titan-design/workflow": minor
---

Add `WorkflowRuntime.quiesce()` and `quiesced()` for a planned handoff. Quiesce releases every live run's lease, then stops admission: `hydrate()` claims nothing, `start()` persists the new run unclaimed for the successor runtime to adopt, and `cancel()` marks the run `cancelling` and releases it instead of finishing it.
