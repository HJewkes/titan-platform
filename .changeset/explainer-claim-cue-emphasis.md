---
"@titan-design/explainer": patch
---

Q-D22 counts each emphasis the fill lights (a later cue on an element already drawn) as motion, ramping up on its word and down after its dwell (TP-4548). claim-card's spec now targets its `claim`, so a cue past the claim's first word passes the emphasis gate and lights it. A one-line target needs no cue of its own, so a cue-less claim-card is still accepted, still split, and the cue-resolution gate does not count it. The Q-D17 and Q-D22 hints offer a cue-less claim-card a claim cue, and the still seed cues a claim only on a word that names it. Script stage x29.
