---
"@titan-design/autoresearch": minor
---

The plan port's input now carries `quota`, the context `quotaViolations` checks the answer against, and the new `quotaRules(quota)` words those quotas with their numbers for a planner brief. A round-1 quota retry now resumes the planner, so its brief carries the violations, instead of re-sending a spawn that joined the exited planner and replayed its first answer.
