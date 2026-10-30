---
"@titan-design/factory": patch
---

Shepherd wakes the fixer at once when a stacked child that GitHub retargeted after its parent squash-merged conflicts with its new base. The conflict no longer waits in the merge order (TP-4566). The wake is the existing conflict round, with the same brief and caps.
