---
"@titan-design/factory": patch
---

Shepherd's fix-proof read no longer settles to `missing` while the `fix-proof-base`/`fix-proof-head` exec jobs exist at the head: it waits for the judge, and a judge still absent at the deadline reads `error` (TP-2520 a).
