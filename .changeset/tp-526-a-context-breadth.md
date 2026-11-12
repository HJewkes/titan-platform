---
"@titan-design/retrieval": minor
---

Add `planContext(candidates, budget)` and `estimateTokens`: a pure token-budget planner that places candidates within per-category token quotas and caps each entry at twice the mean share. It then deepens the best hits one tier at a time with the leftover budget, up to `maxTier`.
