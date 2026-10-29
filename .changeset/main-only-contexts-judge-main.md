---
"@titan-design/factory": patch
---

Shepherd judges main by the required contexts plus the `mainContexts` listed in `.github/required-checks.json`, so a red main-only check such as a test shard freezes main (TP-4401).
