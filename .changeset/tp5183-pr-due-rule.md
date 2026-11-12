---
"@titan-design/session-graph": minor
---

`prsNeedingOutcome` returns `PrDue` rows (`PrKey` plus `band`, `state` and `checkedAt`), ordered by band
(`unchecked`, `recheck`, `backfill`), then least recently checked, then `pr_ref`. `PrResolver` now receives
`PrDue[]`, so a resolver can throttle without reading the `pr` table. New exported types `PrDue` and
`PrOutcomeBand`.
