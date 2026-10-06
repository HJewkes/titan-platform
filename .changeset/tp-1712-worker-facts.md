---
"@titan-design/agent-protocol": minor
---

Add the `@titan-design/agent-protocol/worker-facts` subpath with `WorkerFactsSchema` and the `WorkerFacts` type: the contract for what a spawned worker's completion carries (agent, profile, spawner, task id, last Status or Verdict capped at 2,000 characters, PR, tokens, cost, exit code, signal and inferred).
