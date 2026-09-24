---
"@titan-design/workflow": minor
---

Add `mapItems`, a fan-out with concurrency and budget caps that resumes by item key, and `idempotentRunner`, which redispatches interrupted repeat-safe steps after a restart. Step results carry `usage`. `agentRunner` reports cost and tokens, and stores `outputSchema` output as JSON instead of `[object Object]`.
