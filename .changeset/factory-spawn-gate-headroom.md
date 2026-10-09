---
"@titan-design/factory": patch
---

The Shepherd spawn gate admits a spawn every 15 s while the machine has headroom (load5 under half of buildLoad5, normal memory pressure, few unabsorbed reviews), keeps the 60 s window otherwise, and caps admits at 4 inside any 60 s. `headroomIntervalMs`, `burstMax` and `headroomReviews` are overridable under `shepherd.spawnGate`. Deferred reviews are admitted oldest first (a red main's fix review still first), and a waiter silent for 10 minutes leaves the queue.
