---
"@titan-design/factory": patch
---

Shepherd seat lookup ignores repo entries marked `read_only: true`, so a read-only listing in one seat no longer narrows the owning seat's grants or flips a run to owner-gate.
