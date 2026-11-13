---
"@titan-design/factory": patch
---

review-stats schema v4 stores each round's own-diff id and whether a MERGE or FIX_FIRST pass re-read an own diff unchanged since the run's previous verdict head. The `pr_review` view and `titan-factory stats --reviews` add passes, unchanged passes and their cost per PR, plus totals, medians and the top 10 PRs by unchanged passes (TP-5592 A2).
