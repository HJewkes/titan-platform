---
"@titan-design/graph-layout": minor
---

`computeCompoundLayout` returns every group's absolute box on `groups` and routes edges whose ends are group ids in the same ELK pass, so every level of a map reads one layout. Add `routeToPathD(route)`, the `LaidOutGroup` and `CompoundLayoutResult` types, and pin `elkjs` to 0.10.2 (TP-2810).
