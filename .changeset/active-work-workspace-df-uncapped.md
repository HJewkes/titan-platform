---
"@titan-design/active-work": patch
---

Workspace-class queries keep their common terms once a graph has cut over to the workspace span table. They rank only that small table, so the document-frequency cap no longer pays for itself there. Queries that include `transcripts`, and any query on a graph still holding legacy workspace spans, stay capped.
