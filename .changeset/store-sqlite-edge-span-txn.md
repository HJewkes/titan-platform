---
"@titan-design/store-sqlite": patch
---

Run `EdgeTable.supersede` and `SpanFtsTables.index` each in one transaction, so a failed insert no longer leaves a retracted edge with no replacement or a span row with no FTS row.
