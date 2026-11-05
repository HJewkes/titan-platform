---
"@titan-design/render-qa": patch
"@titan-design/explainer": patch
---

`frameDiffs` no longer counts a one-frame codec blip as picture change (TP-4558). An h264 keyframe re-quantises a still picture for one frame, a few levels on a few hundred pixels, and the next frame returns to the picture exactly. That frame now reads as its predecessor, so the static-window gate sees one still instead of two short ones. A one-frame change of more than 12 levels, or one the next frame keeps, still counts. The explainer qa stage version moves to x11c.
