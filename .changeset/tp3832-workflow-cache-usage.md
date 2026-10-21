---
"@titan-design/workflow": minor
---

`StepUsage` gains optional `cacheReadTokens`, `cacheWrite5mTokens`, `cacheWrite1hTokens` and `model`. `agentRunner` fills them from the run's usage, and `addUsage` and `usageFromMeasurements` carry them. Absent stays absent.
