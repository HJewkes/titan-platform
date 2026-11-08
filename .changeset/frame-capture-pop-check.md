---
"@titan-design/frame-capture": minor
---

Add `checkPops`, a pop check for captured timelines. It seeks a grid of `t`; where a step's change reaches a threshold it re-measures the step at h/2, h/4 and h/8 and reports a pop only when the change does not halve, so a mount, cut or jump is flagged and fast smooth motion is not. `measureHalving`, `isPop` and `changedPixels` (a pixel-count delta for raw RGBA frames) are exported with it. The halving test is adapted from anatomy's `kit/turn-audit.mjs` (MIT, attributed in NOTICE).
