---
"@titan-design/factory": minor
---

Honour the owner's claimed plan approvals at Shepherd's merge guard (TP-4284 slice 2). `skill-path` and the `visual-path` glob row clear when one approval names every triggering path. `ci-policy-weakened` clears only when one `ci-policy` approval holds the reviewer's keys and pins every changed path at head, rename sources included, to its exact blob. On a weakened line the evidence step now records `headBlobs` (each changed path's git blob sha at head, up to 20). A failed read leaves the field out, so the row gates. `EffectivePolicy.approved` is attached by each `sh-policy` read and never accepted from a run param or the store.
