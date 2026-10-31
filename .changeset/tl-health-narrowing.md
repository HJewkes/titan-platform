---
"@titan-design/health": patch
---

The store and metrics validator now narrow database rows, stats and the schema id with zod and equality checks instead of type assertions. A schema id that names an inherited object key, such as `toString`, now returns the usual schema-id error instead of throwing.
