---
"@titan-design/factory": patch
---

The event log can derive `CIConcluded` occurrence keys for check runs and statuses from a webhook delivery or a GraphQL backstop node, so one occurrence from both sources stores one row (TP-3390, TP-3095 S2). Nothing reads or emits them yet.
