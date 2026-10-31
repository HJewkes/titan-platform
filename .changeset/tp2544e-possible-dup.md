---
"@titan-design/active-work": minor
---

`task add` tags an agent-filed task `possible-dup:<id>` when its title scores at least 0.9 title jaccard against the closest related open task. A refused tag write warns and leaves the task filed; the older task is never edited (TP-2544).
