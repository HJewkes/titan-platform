---
"@titan-design/explainer": patch
---

Template beats now light the element a later cue names. The fill emits `emphases` for a cue on an element it already drew: a list row or bar or stat figure named again, an arch-map node named again, an arch-map edge once both its ends have landed, or the claim of a claim-card (drawn and filled; the claim-card spec takes a `claim` cue target in a later slice). The timeline carries them as `emphases: {target, atS}[]`, and each template lights the named element with the arch-map token's treatment (a 25 % brand tint and a brand ring; a brand stroke under an edge) for the flow token's 0.8 s dwell, ramping 0.2 s each side. The change stays inside the named element's box. Render's stage version is bumped.
