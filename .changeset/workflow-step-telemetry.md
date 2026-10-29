---
"@titan-design/workflow": minor
---

Keep per-step telemetry. A completed dispatch's `StepResult` now records `startedAt`, `firstStartedAt` and `restarts`, and a seed's records `startedAt`; `projectRunTrace` places each attempt at its recorded start. Every `WorkflowEvent` carries `at` from the runtime clock. A `codeRecordRoute` body may return `usage` beside `result`; the route reports it as the step's usage, so `mapItems` sums and budgets it like a dispatch's. All fields are optional, so stored runs and events from earlier releases read as before; no migration is needed.
