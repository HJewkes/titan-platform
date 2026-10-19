---
"@titan-design/factory": patch
---

TP-3697: Shepherd passes two always-approved owner gates on guards, each leaving an audit record (PR comment, watch row `autoPassed`, owner digest FYI section). D7 failed-rounds: infra-only failures with a standing MERGE and green CI go on to the merge policy; otherwise one fresh reviewer goes before the owner. D13 main-red: the acknowledge-only gate is an FYI record. `GATE_DEMOTIONS` reverts each class with one line. Visual and gate-2-visual gates (D2) still wait for the owner.
