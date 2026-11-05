---
"@titan-design/factory": patch
---

Persist each restart rollback's deploy incident to `deploy-incidents.jsonl` in the deployer's state dir; every deploy creates the log, so an absent log reads as unknown and an empty one as no incidents.
