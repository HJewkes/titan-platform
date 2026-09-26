---
"@titan-design/workflow": patch
---

`mapItems` keeps launching after a retryable item failure, stops on a non-retryable one or once failures exceed `maxFailures` (default 3), and counts failed-call cost in `spentUsd`. `StepFailedError` now carries `retryable` and `usage`, and `agentRunner` reports usage on failed runs (TP-372).
