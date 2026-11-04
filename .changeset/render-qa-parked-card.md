---
"@titan-design/render-qa": minor
"@titan-design/explainer": patch
---

`off-frame` findings now carry `parked: true` when the painted rect has no area on the frame, and `classify` drops a parked finding when the element paints on frame at a later sample of its beat, so a card waiting for its cue is no longer a held error. A card that never enters during its beat stays off-frame, and a card partly past an edge is judged as before. The explainer's render and qa stage versions are bumped.
