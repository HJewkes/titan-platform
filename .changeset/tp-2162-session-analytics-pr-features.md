---
"@titan-design/session-analytics": minor
---

`taskActuals` takes a `prDiffs` cache keyed by PR ref and adds `prClass`, `touches` and `changedLines` from review-panel's `classifyPr` and `changedLineCount` over all of a task's merged PR files; a merged PR missing from the cache gives nulls and the `pr-diff-missing` flag. New exports `prFeaturesFor`, `listMergedPrRefs`, `parsePrRef` and the `PrDiff`/`PrFeatures` types (TP-2162 a).
