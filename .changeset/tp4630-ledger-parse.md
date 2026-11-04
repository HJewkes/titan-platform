---
"@titan-design/agent-lifecycle": patch
---

The SQLite execution ledger now parses stored snapshot, receipt and event rows with the agent-protocol lifecycle schemas and throws a clear `TypeError` on a malformed row instead of returning it unchecked. Unknown keys on a stored row are kept.
