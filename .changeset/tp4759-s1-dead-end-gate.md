---
"@titan-design/factory": minor
---

Shepherd gains an `sh-dead-end` seat gate (TP-4759 S1, owner decision 552), behind `GATE_DEMOTIONS.deadEndSeat`, which stays off, so no run opens one yet. The gate records its addressee: the registrant, else the live seat that spawned it, else the repo's one seat. It tells that seat and asks it at the head under a `shepherd-dead-end` rule that admits the owner classes and a coordinator. `titan-factory gate resolve` admits only the addressed coordinator, on fresh `seat-dead-end` evidence that the PR is still open at the gate's head, for `respawn` or `abandon`. The owner-only `waive-proof` and `owner-merge` answers stay the owner's. Respawn waits for a new head and is offered twice per run. In this slice abandon only stops the run. The owner inbox leaves these gates out, `shepherd waiting` lists them as seat work, and a moved head supersedes them.
