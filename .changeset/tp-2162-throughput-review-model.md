---
"@titan-design/throughput": minor
---

Add `reviewTable`, `reviewFor` and `reviewAblation`: recency-weighted quantiles of reviewer agent-hours, review rounds and post-PR wall hours, keyed on review class x lead touch with back-off, and a rolling-origin ablation of that key against kind x size band. `ThroughputRow` gains optional `prClass`, `touches`, `changedLines`, `reviewRounds` and `stageMinutes` (TP-2162 b).
