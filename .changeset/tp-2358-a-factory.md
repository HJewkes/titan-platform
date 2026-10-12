---
"@titan-design/factory": patch
---

The Shepherd account wait releases the run's own hold only when the PR reads `closed`; any other or failed read keeps the hold (TP-2358 a).
