---
"@titan-design/factory": patch
---

Shepherd leaves a registered task open when it is tagged `slices` or `multi-slice`, so a slice PR merge no longer closes a multi-slice parent that has no plan slices block.
