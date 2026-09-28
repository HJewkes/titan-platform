---
"@titan-design/workflow": minor
---

Key every memoized call by step id and call index, and record the method that wrote it. `seed` now counts toward the shared per-step counter, so `seed("x")` followed by `assisted("x")` opens a gate instead of returning the seed's result, and a second `seed("x")` runs as a new call. A replay that reaches a recorded call through a different method fails with the new `WorkflowNonDeterminismError`. `StepResult` gains an optional `operation` field. Runs stored by 0.4 and earlier keep their old keys and resume unchanged.
