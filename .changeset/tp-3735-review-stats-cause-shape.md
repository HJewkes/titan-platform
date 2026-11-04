---
"@titan-design/factory": minor
---

`shepherd stats --reviews` labels each review round with its cause (first, fix-round, convergence or other), its panel member's shape and whether its brief was scoped (review-stats schema v2; v1 rows are relabelled on the next refresh). It adds a shape-and-cause cut, token distributions, and fix-round p50/p90 dollars and tokens per shape before vs after the first scoped round or `--since-scoped <date>`, split scoped vs full. Each panel member's verdict now resolves its own round.
