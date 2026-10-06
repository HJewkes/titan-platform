---
"@titan-design/code-graph": minor
---

Export `hotspotComplexityOf(ctx, nodeId)` from `@titan-design/code-graph/analysis`: the complexity factor a file's hotspot score multiplies (max cognitive, else max cyclomatic), read even when the file has no churn, and undefined when unmeasured. code-read's `paths.impact` reports it.
