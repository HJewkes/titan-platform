---
"@titan-design/factory": patch
---

TP-3697: Shepherd demotes two always-approved owner gates, each leaving an audit record (PR comment, watch row `autoPassed`, owner digest FYI section). D7 failed-rounds: when every counted round failed on infrastructure, one fresh reviewer goes before the owner, and the owner is asked only if it fails too; D7 never merges by itself. D13 main-red: the acknowledge-only gate is an FYI record. `GATE_DEMOTIONS` reverts each class with one line. Visual and gate-2-visual gates (D2) still wait for the owner.
