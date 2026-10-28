---
"@titan-design/explainer": patch
---

Q-F1 now reports the measure it failed on. When the link rate passes and one connective opens too many linked beats, the row's value is that connective's share against the 40 % cap, not a link rate of 1 against 0.7, and the row names the beats the connective opens. The Q-F1 repair hint says which half failed and gives both values, the connective tally, and the connector_in to change on each beat past the cap. It asks for a connective that keeps the same logical link, and never for dropping the link. Every repair hint now names the beats its row names: a hint that re-reads the script and names none of them gets the row's beats appended. map:hand-framing gets a hint of its own. Script stage version x17, rewrite x11, eval x11.
