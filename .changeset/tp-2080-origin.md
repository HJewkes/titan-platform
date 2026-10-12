---
"@titan-design/factory": patch
---

Shepherd records one observe-only `sh-head-origin` step for every head it did not make (`merge-of-base`, `merge-other`, `push` or `unknown`), read from the head commit's parents and a compare of its second parent against the base. `shepherd stats` counts the `merge-of-base` ones as `foreignMergeUps`.
