---
"@titan-design/factory": patch
---

A replay-diverged shepherd run with a pending owner gate stays parked instead of being restarted, which cancelled the gate and left the new run never asking the owner again (TP-3801). `shepherd.owner-load.waiting_now` now counts each held registration with no pending gate, so it cannot read PASS while an owner gate is missing.
