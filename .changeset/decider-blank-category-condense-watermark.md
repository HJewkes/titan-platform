---
"@titan-design/decider": patch
---

`route` and `score` no longer throw on a ledger category that normalizes to empty: a blank category uses the `other` policy row and score bucket. `condense` no longer advances a domain's watermark, or records its feedback, when the reflector's output is not an array, so the next run offers the same rows again.
