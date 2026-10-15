---
"@titan-design/tool-guard": patch
---

`splitReading` takes an optional IFS that overrides the one the walk holds, so a caller can split with an IFS the line may hold at run time: one assigned later in a loop or function, or bash's default after `unset IFS` (TP-2729 b).
