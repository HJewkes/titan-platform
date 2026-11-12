---
"@titan-design/factory": patch
"@titan-design/coordinator": patch
---

Add the `owner-tier` merge guard row (TP-5406, gate model S2). A reviewed head that changes a merge-policy, hold-command, owner-action, gate-resolve-actor or gate-resolve-check file, a CI workflow file (unless the change is a measured CI budget), a publish file, a settings file, or a policy path no named table covers raises the owner gate at merge. The live switch `shepherd.gateReset.ownerTier` (off, shadow, on; absent means shadow) is a new editable factory row; under shadow the merge evidence records the rows it would have gated on and no outcome changes.
