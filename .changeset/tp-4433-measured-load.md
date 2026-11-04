---
"@titan-design/factory": minor
---

The spawn gate reads measured headroom. A review now adds `reviewLoad` 0.05 cores to the load it is compared with, not 4: a 2026-10-29 sample of a 48-core host had reviewers running no tests and every claude process together at about 0.3 core. A new `spawnGate.minIdleCores` (default 1) refuses any spawn while the core count less load1 less the unabsorbed reviews leaves fewer cores idle; it is not applied where load1 or the core count is unread. `review.maxConcurrent` stays the backstop on how many reviews start. Deferral and admission lines show load1 and the core count.
