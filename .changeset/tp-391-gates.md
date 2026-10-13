---
"@titan-design/workflow": minor
---

`projectRunTrace` now emits gate and artifact records (TP-391 b): human gates read from the hitl gate store for `assisted` steps, owner-gated `authorize` steps and a paused run's pending gate (prompt and payload as digests only, `decidedBy` as `human:owner` or `agent:<id>`), plus the policy gates and artifacts a step carries under `StepResult.data["titan.trace.gates"]` and `["titan.trace.artifacts"]`, parsed strictly. A malformed entry throws naming the step. Export `TRACE_ARTIFACTS_KEY` beside `TRACE_GATES_KEY`.
