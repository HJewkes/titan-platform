---
"@titan-design/explainer": patch
---

Resolve gates on chart integrity. The `chart` and `replot` slots take optional `baseline`, `axisBreak`, `scale` and `legend` fields, and a new `chart-integrity` gate fails bars on a baseline above zero or with a broken axis, a sequential colour scale whose CIELAB lightness is not monotonic or a diverging one not light at its centre, and a legend on six or fewer series, where direct labels fit. The resolve stage version moves to p5c2s2f2s2c.
