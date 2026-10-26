---
"@titan-design/factory": patch
---

Add a merge-order reservation store (migration 40), a path-overlap rule and a merge guard chained last in the hold chain. It ships off: `merge-order.json` disables it for every repo and nothing writes a reservation yet, so merges behave as before.
