---
"@titan-design/factory": patch
---

Delete the dormant pixel tier 1 (`no-pixel-diff`) from Shepherd's visual tier. A rendered path is always tier 2 ("renders: <paths>"), and a stored tier record with basis `no-pixel-diff` fails the record schema, so it gates as tier 2.
