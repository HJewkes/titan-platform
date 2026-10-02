# @titan-design/evidence

## 0.2.1

### Patch Changes

- e54f34e: `wilson` returns exactly 0 for the lower bound at no successes and exactly 1 for the upper bound at all successes. The `sd` doc and the README paired-bootstrap example are corrected.

## 0.2.0

### Minor Changes

- a737546: New `@titan-design/evidence/stats` subpath: `wilson`, `betaBinomialInterval`, `bootstrapCI`, `pairedBootstrap`, `mcnemar` and `minimumDetectableEffect` for small-sample eval scoring. Bootstraps draw from `seededRandom` and are reproducible; no interval uses the normal approximation.

## 0.1.0

### Minor Changes

- 4a9eae9: New tier-0 package: `verifyCitation` checks a cited path, line range, shown lines and
  whitespace-normalized quote; `groupByOverlap` groups findings whose ranges share a line;
  `pickControls`, `placeControls` and `scoreControls` plant seeded controls and score
  per-label precision and recall. Lifted from the repo-review tools (TP-354).
