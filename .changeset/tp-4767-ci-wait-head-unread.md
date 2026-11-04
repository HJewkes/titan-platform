---
"@titan-design/factory": patch
---

Shepherd status no longer names an older step's head while a ci-wait runs: the row names the head that wait read, or says "waiting for CI (head not yet read)" until its first read (TP-4767).
