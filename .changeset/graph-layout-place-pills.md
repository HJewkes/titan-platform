---
"@titan-design/graph-layout": minor
---

Add `placePills(scene, pins, config)`: a top-left box for each pin's pill beside its anchor box, inside the frame above a caller-given keep-out line, clear of every listed obstacle and every earlier pill, in rank-then-id order. A pill with no clear spot is returned in `dropped` (TP-2976).
