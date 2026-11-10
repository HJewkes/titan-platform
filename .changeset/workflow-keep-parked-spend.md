---
"@titan-design/workflow": patch
---

A parked durable step keeps the spend its first `cancellation_unknown` report carried when a later report for the same step has no usage. Before, the repeat report dropped the recorded spend, so the operator's answer was charged nothing.
