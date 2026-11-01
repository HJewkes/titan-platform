---
"@titan-design/explainer": patch
---

Resolve's custom-layer build check now reads each layer's source and refuses text that enters by an opacity fade (a ramp, a computed value or anything below 1 on an element that renders text). The finding joins the text-rule findings in the layer's one rebuild, and a contrast finding on a fading element repeats the full-colour rule. The custom-layer doctrine states it, and resolve's stage version moves to `p5c2s2f2s2d7`.
