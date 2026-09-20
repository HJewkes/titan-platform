---
"@titan-design/code-graph": minor
---

Export the batch the final codewatch swap needs, and port partition quality and prune (TP-250).

New root exports, all already implemented internally: the history adapter (`loadHistoryMetrics`, `LoadedHistory`, `HistoryMetricsOptions`, `DEFAULT_CHURN_WINDOWS`, `resolveChurnWindows`, `windowSuffix`, `computeRecencyWindows`), which stays outside the `./history` seam because it speaks `GraphMetric`; the rules engine's glob matching (`patternToRegex`, `compilePatterns`, `matchesAny`); `computeDeepAst` with `DeepAst`, `DeepAstInput`, `MemberInfo`, and `ParamInfo`; and `resolveGitRef`.

New `CodeGraphStore` methods: `listMetricNames`, `topByMetric`, and `replaceMetricsByName` (the wholesale swap a re-ingested overlay such as coverage needs), plus `deleteSnapshots`, `vacuum`, and `countRowsByTable`.

Ported from codewatch's `packages/graph` unchanged, with their tests: `computePartitionQuality` and `invertBuckets` (`src/analysis/partition-quality.ts`), and `planPrune` and `runPrune` (`src/prune.ts`). The domain tables declare no foreign key, so `deleteSnapshots` clears each of `SNAPSHOT_SCOPED_TABLES` itself instead of relying on codewatch's cascade; `boundary` and `entry_point`, which this schema never created, leave the list.

Additive: no schema migration, no new index, no `INDEX_VERSION` change (still 0.15.0). When this releases, codewatch deletes its `packages/graph/src/history-adapter.ts` copy and consumes these exports instead.
