---
---

Test only: tool-guard's `withinParseBudget` default is sized from measured CI thread CPU (259.4 ms at most) to 500 ms, so the depth-8 parse-budget sweep no longer flakes on CI (TP-3898).
