---
"@titan-design/factory": minor
---

Shepherd's dead ends now ask the registering seat by default (TP-4759 S5, owner decision 552): `GATE_DEMOTIONS.deadEndSeat` is on. A new verb, `titan-factory shepherd readdress-dead-ends`, moves the dead-end owner gates that were already pending. Without `--apply` it only lists each gate and the seat it would go to. With `--apply` it cancels each gate that has a seat, using the reason `superseded: readdressed: <seat> (TP-4759)`, and the run then asks that seat at the same head. It matches only a rule-less exit sent-back worded exactly as Shepherd writes it, or a rule-less approve-merge under `shepherd-route/fix-first-runaway` or `shepherd-route/failed-rounds`. A gate with no resolvable seat stays the owner's.
