---
"@titan-design/render-qa": patch
---

Judge off-frame and the other box rules on an element's painted rect: its box less what its `clip-path: inset(...)`
and its ancestors' hide. A fully clipped box is not judged; percentage insets are read as percentages, and under a
rotation or skew the layout box is kept.
