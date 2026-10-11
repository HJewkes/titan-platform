# @titan-design/throughput

## 0.1.1

### Patch Changes

- 702881e: Add internal back-test scoring metrics (interval coverage with a Wilson interval, pinball loss, median absolute log error, Spearman, 150k-context precision and recall, conformal widening factor) and depend on `@titan-design/evidence` for the Wilson interval. Not yet exported; `backtest` lands in a follow-up.

## 0.1.0

### Minor Changes

- 60d12aa: Add `@titan-design/throughput` with `classTable` and `classFor`: recency-weighted (21-day half-life) p10/p50/p80/p90 of implementer hours, reviewer hours and USD per kind x size band, backing off kind, size band, initiative, then global below 20 weighted rows. The table carries a model hash, the snapshot watermark and the package version.
