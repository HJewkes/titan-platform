---
"@titan-design/workflow": patch
---

Emit the documented `step_failed` event before every `StepFailedError` a run context throws: retries exhausted, non-retryable failures, invalid output, and authority deny or refuse. A failing `mapItems` item now emits it too.
