---
"@titan-design/factory": patch
---

The deploy block and the deploy pacer count a running build that descends from an asked or wanted sha as having landed it, so a later commit deployed by hand no longer reads as a stalled deploy. When git cannot settle ancestry the ask stays behind and the block says why.
