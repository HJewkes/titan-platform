---
"@titan-design/explainer": minor
---

Add the script/v1 profile fields (TP-4014): a beat's visual may give its `layer`, `framing`, grid `anchors` and `scene`, and a cue may end its emphasis span with `untilCue`. A script records the `structure` it was planned under; `parseScript` rejects one the registry lacks, and `explainer run` records `design-journey`. `signature_layer` is optional and no check requires it. Q-E15 now runs only for design-journey scripts and legacy scripts that name no structure. `cueElement` resolves a cue target to exactly one emphasis element.
