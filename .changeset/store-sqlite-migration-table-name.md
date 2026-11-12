---
"@titan-design/store-sqlite": patch
---

Migration SQL now interpolates `MIGRATION_TABLE_NAME` everywhere (TP-1310), and `appliedVersions` reads through the same reader as the name check instead of repeating the create-and-query step.
