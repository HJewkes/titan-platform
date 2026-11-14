---
"@titan-design/evidence": minor
"@titan-design/review-panel": patch
---

Export `citationsIn` and `citationHolds` from evidence; review-panel's aggregate and the evals replay score use them instead of their own copies of the `path:line` reader.
