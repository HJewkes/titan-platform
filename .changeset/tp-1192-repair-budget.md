---
"@titan-design/factory": patch
---

Shepherd now spends one repair budget per run on every fixer wake (ci-red, conflict, FIX_FIRST review, fix-proof), counted across heads and persisted as a step. A wake past `MAX_REPAIRS` opens one owner gate naming the wake kind and, for ci-red, the failing checks.
