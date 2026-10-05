---
"@titan-design/code-read": minor
---

Add the `changes.get` command (contract 0.1.5): against a required `baseline`, the files that crossed the hotspot `cutoff`, files the baseline does not hold, findings new, worsened, improved, and resolved, new co-change coupling (reported `measured: false` until pairs are stored), and regressions, files whose score rose that carry an open finding. Across index versions it returns `comparable: false` and empty lists. It reuses code-graph's `computeReportDrift` and `bucketViolations` through `@titan-design/code-graph/analysis`, so the live handler and the static resolver return the same result.
