---
"@titan-design/code-graph": patch
---

`openCodeGraph` refuses a database stamped past `SCHEMA_VERSION` with `SchemaTooNewError`
instead of querying a schema a newer build already moved on from.
