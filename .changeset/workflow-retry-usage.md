---
"@titan-design/workflow": patch
---

Count every attempt's cost in `StepResult.usage`. A step that fails and then succeeds on retry now reports the failed attempts' cost too, and the active step persists that cost as the new optional `ActiveStep.priorUsage` field so a resumed run counts each attempt once. `durableHarnessRunner` now reports `usage` on success from the harness's measurements, and a legacy `attach` recovery keeps the usage its runner reported.
