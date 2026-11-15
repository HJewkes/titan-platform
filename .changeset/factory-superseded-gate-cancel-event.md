---
"@titan-design/factory": patch
---

Shepherd register now records a gate-cancel event on the new run when it supersedes a replay-diverged run that had a pending gate, naming the old run, the gate's step and the new run.
