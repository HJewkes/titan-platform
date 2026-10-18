---
"@titan-design/factory": patch
---

Serve's head-moved sweep no longer cancels the approve-merge gate of a run under an owner hold when its PR base moved, so the gate is kept for both serve and `shepherd resync`. The owner hold is read again right before the cancel. A dry-run resync also lists a gate once when both the transient and the base sweeps would cancel it.
