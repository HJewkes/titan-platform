# @titan-design/evidence

## 0.1.0

### Minor Changes

- 4a9eae9: New tier-0 package: `verifyCitation` checks a cited path, line range, shown lines and
  whitespace-normalized quote; `groupByOverlap` groups findings whose ranges share a line;
  `pickControls`, `placeControls` and `scoreControls` plant seeded controls and score
  per-label precision and recall. Lifted from the repo-review tools (TP-354).
