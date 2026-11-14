---
"@titan-design/factory": patch
---

Recording a merge-wait timeline row is best-effort (TP-5888): a store error such as SQLITE_BUSY is logged with the PR and no longer fails a held merge step.
