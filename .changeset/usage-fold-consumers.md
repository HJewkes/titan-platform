---
"@titan-design/session-read": patch
"@titan-design/workflow": patch
---

session-read's `SessionUsageAccumulator` and workflow's durable-harness usage now select measurements with agent-protocol's `foldUsage` and no longer carry their own copies of the fold. Results are unchanged (TP-423).
