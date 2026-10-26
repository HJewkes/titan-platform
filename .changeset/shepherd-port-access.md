---
"@titan-design/factory": patch
---

Shepherd: each registry command now declares its in-process access (`read`, `write`, or `list-or-write`) in `shepherd/port-access.ts`, and the agent-env in-process refusal is computed from it instead of a hand-kept name list (TP-4281). The refused set is unchanged; a command added without a declaration fails typecheck and a test.
