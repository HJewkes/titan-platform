---
"@titan-design/explainer": minor
---

Add the pace lints as an L0 check: paceCheck (in L0_CHECKS) and paceRows emit Q-E7 (at most 4 new items a beat, error), Q-E8 (seconds a new item), Q-E9 (15 s between dense beats) and Q-E10 (new items a chapter minute, via chapterPace) as warnings; L0Input and runL0 take heard timing (TP-2979).
