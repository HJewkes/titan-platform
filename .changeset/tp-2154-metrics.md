---
"@titan-design/throughput": patch
---

Add internal back-test scoring metrics (interval coverage with a Wilson interval, pinball loss, median absolute log error, Spearman, 150k-context precision and recall, conformal widening factor) and depend on `@titan-design/evidence` for the Wilson interval. Not yet exported; `backtest` lands in a follow-up.
