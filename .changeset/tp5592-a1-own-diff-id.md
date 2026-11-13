---
"@titan-design/factory": patch
---

Shepherd records an `sh-own-diff` id for each reviewed head: the patch id of the head's diff against its merge base with the base branch, leaving out generated paths, the registry lock and attestation rows. It is measurement only; nothing reads it to decide (TP-5592 A1).
