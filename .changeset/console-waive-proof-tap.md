---
"titan-console": minor
---

Offer "Waive fix-proof" on a waivable sh-sent-back gate (TP-3626). Where the gate's own options list `waive-proof` (a NO_REPRO send-back, or a fixer's exit from a fix-proof wake), the item keeps its "Wait for new head" tap and gains a second, outline-styled one. `inbox.prepare` and `inbox.act` take an optional `decision` to pick it; the read-back says the fix-proof is skipped for the shown head only, that the tap merges nothing, and that the merge still needs the owner's Approve merge tap. A gate whose options do not list `waive-proof` is never offered it, and the posted record names the one decision given.
