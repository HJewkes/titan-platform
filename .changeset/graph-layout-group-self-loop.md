---
"@titan-design/graph-layout": patch
---

`computeCompoundLayout` no longer hands a group-to-itself edge to ELK. The edge stays in the output without a route.
