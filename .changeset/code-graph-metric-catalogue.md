---
"@titan-design/code-graph": minor
---

Add a metric catalogue and targeted store reads for the read API (TP-183). `METRIC_CATALOGUE`, `describeMetric`, and `describeMetrics` describe every metric name code-graph writes: unit, node kinds, rollup rule, direction, what a missing row means, and the writing module, with windowed names as `{w}` templates. `listMetricsForNode`, `listEdgesTouching`, and `aggregateMetrics` (also on `CodeGraphStore`) read one node or one metric through existing indexes. Additive: no schema migration, no new index, no `INDEX_VERSION` change.
