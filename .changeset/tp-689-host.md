---
"@titan-design/evals": minor
---

TP-689a: add the trial host. `createTrialHost` runs one variant on one case in a workflow runtime over the trial's own SQLite file, with one route per variant step: `code` steps run the topology's in-process implementation, `agent` and `llm` steps go through an injected launch port, and `gate` and `unit` steps are refused by name. The trial record holds every attempt, a call per `tool_use` block, and cost and tokens from the launch's usage. A session that ran a model other than the step's fails the trial, and `rate_limited`, `auth_misconfigured` and `runtime_error` mark it `infra`. Not exported yet; slice b adds resumable runs and the exports.
