---
"@titan-design/code-graph": patch
---

Write each indexed snapshot row together with its nodes, edges, aliases, metrics and fingerprints in one transaction, so a reader on another connection never sees a head snapshot whose rows are partly written. Adds `CodeGraphStore.atomically`.
