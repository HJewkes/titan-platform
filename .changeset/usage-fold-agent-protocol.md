---
"@titan-design/agent-protocol": minor
---

agent-protocol: export `foldUsage`, one pure fold that picks the `UsageMeasurement`s describing distinct spend (deltas deduplicated by `responseId` and superseding snapshots; the highest-sequence snapshot per scope, scope ID and epoch; a conversation snapshot superseding other scopes in its epoch) (TP-423).
