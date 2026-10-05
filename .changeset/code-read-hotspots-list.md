---
"@titan-design/code-read": minor
---

Add the `hotspots.list` command (contract 0.1.3): files or symbols ranked by hotspot score over a churn window, with a caller-supplied cutoff, offset paging, and new or worsened marks against a baseline. Both grains reuse code-graph's report derivations through `@titan-design/code-graph/analysis`, so the live handler and the static resolver return the same rows.
