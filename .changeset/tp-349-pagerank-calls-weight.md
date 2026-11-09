---
"@titan-design/code-graph": patch
---

`computePageRank` now gives `calls` edges weight 0 by default, so direct callers rank the same file-level graph the store's default edge read returns. Pass `edgeWeights: { calls: 1 }` to opt in.
