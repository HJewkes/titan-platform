---
"@titan-design/explainer": patch
---

The qa stage's static-window gate now starts a reading hold when the text appeared, not at the first probe sample that shows it. That moment is the earliest cue of the text's beat between the last sample without the text and the first one with it. With no cue in that gap, it is the first frame there that moves after a still one. With neither, it stays the first sample. On the 2 Hz sweep, the old start could excuse up to half a second of still picture after the hold, so a still run over `pacing.staticMaxS` could pass. The qa stage version moves to x11c.
