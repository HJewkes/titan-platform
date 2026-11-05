---
"@titan-design/factory": patch
---

Shepherd's replay-diverged sweep no longer spends an owner's merge answer. If the owner answers a parked run's approve-merge gate with `merge`, the sweep merges the PR at that head instead of restarting the run, provided the head has not moved and land's own reads pass: required checks green, not behind on a strict repo, no conflict, and the base the gate named. The run ends with a `sh-carried-merge` step that names the gate. Any other answer, a moved head or a failed read restarts the run as before (TP-3918).
