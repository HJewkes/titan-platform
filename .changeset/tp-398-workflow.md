---
"@titan-design/workflow": patch
---

`durableHarnessRunner` reports the usage on a failed durable terminal, so `StepFailedError.usage` and the `mapItems` budget count what a failed durable step spent.
