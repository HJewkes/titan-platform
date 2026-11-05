---
'@titan-design/active-work': patch
---

Cache each initiative's `inventory` scan in the daemon, keyed by its record directories' mtimes with a 30 s TTL, so repeat calls skip the per-file stat walk (TP-4508).
