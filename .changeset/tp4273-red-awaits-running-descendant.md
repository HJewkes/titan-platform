---
"@titan-design/factory": patch
---

Shepherd no longer freezes a repo or spawns a fixer for a main red whose fix already merged with its run still in progress (TP-4273). When a red stands its full wait and no green commit contains it, Shepherd reads the base tip: if the tip is a later commit containing the red sha and its required runs are still going with none failed, the red is held as awaiting that run. Its green acknowledges the red and clears it; its red lets the red stand on the next poll and opens the normal episode. The hold shares the main-CI read's re-check budget, so a tip that never settles still freezes. A tip whose runs cannot be read, or a repo with no readable required contexts, keeps the red as before. The `sh-main-ci` result records the held-for commit as `awaitedSha`. The fix PR need not be marked by hand for this window.
