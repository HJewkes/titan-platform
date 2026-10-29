---
"@titan-design/factory": patch
---

Shepherd no longer freezes a repo on a stale or cancelled main red (TP-4230). Before a red that stood its full wait freezes the repo, Shepherd reads the base tip and the default branch's recent commits for one that is or contains the red sha and is green on every required context; if it finds one, the red is read as stale and acknowledged on that commit, so no episode opens and no fix task is filed. A failed read keeps the red. A failed read made of cancelled runs plus required jobs skipped behind them now reads as a cancel, which waits, and never as red; main-watch reads it the same way. A freeze now names the sha the red was read at, so a merge whose own run concurrency cancelled is never frozen as red.
