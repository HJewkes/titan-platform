---
"@titan-design/retrieval": patch
---

`planContext` now rejects a `maxTier` or `defaultTiers` entry that is negative, fractional or NaN with a `RangeError`, as it already does for the token budget.
