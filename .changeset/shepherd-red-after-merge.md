---
"@titan-design/factory": minor
---

`shepherd stats` reports `redAfterMerge` per repo and ISO week: merged runs, those whose stored `sh-main-ci` read was red, the rate, and the red PR numbers in `--json`. Resync and serve's 5-minute sweep mark a merged run `sh-reverted`, with the reverting sha, when a later main commit reverts its merge, reading main once per repo; stats counts those too.
