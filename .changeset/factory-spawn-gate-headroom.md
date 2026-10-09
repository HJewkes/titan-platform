---
"@titan-design/factory": patch
---

The Shepherd spawn gate admits a spawn every 15 s while the machine has headroom (load5 under half of buildLoad5, normal memory pressure, few unabsorbed reviews), keeps the 60 s window otherwise, and caps admits at 4 inside any 60 s. `headroomIntervalMs`, `burstMax` and `headroomReviews` are overridable under `shepherd.spawnGate`. A spawn-gate deferral of a review is now a machine hold, so its waiting is spent from the 3 hour hold ceiling rather than the 30 minute busy budget, and a backlog no longer ends reviews as `none`.
