---
"@titan-design/active-work": patch
---

`scanInventorySlug` now returns every visible file the indexed classes and nested sources do not claim as class `other`, with `indexed: false`. The inventory summary skips `other` until the wire schema adds it.
