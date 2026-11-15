---
"@titan-design/explainer": patch
---

Add `keyBoxRows` and `revealRows`, which check a camera track: a key box must stay in the frame above the caption band while it is in play (`camera:key-in-frame`), and a reveal object must not be wholly framed before its cue (`camera:seen-before-reveal`) (TP-6319).
