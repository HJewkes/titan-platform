---
"@titan-design/workflow": patch
---

`agentRunner` forwards a step's `schema` to the agent as its output schema, ahead of `defaults.outputSchema`, and a `schema_invalid` agent failure now ends as a non-retryable `StepOutputInvalidError` through `agentRunner`, `idempotentRunner` and `routedRunner`.
