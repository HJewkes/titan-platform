---
"titan-console": minor
---

A Ship round shows main vs head only. `rounds import` refuses a Ship round with more than one merge-bound question, an image frame with no main frame that is not marked new at head (`change: "new"` or "(new at head)" in its label), or exploration content, meaning alternatives side by side (an `alternate` column, or `A/B`, `proposal` or `alpha` in a key or label; a lab story new at head ships). Each refusal names the frame or variant and the rule. The Ship page labels each pair BEFORE (main) and AFTER (head), names what ships (PR, head and changed-frame count), shows changed frames first and folds unchanged pairs into an "N unchanged" disclosure. `rounds.frames` marks each frame `unchanged` when frames.json gives its base and head one sha256.
