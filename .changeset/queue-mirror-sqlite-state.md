---
"@titan-design/queue-mirror": minor
---

Adds `@titan-design/queue-mirror/sqlite`: `SqliteMirrorState`, a durable `MirrorState` over `@titan-design/store-sqlite` whose `commit` runs in one transaction, plus `mirrorMigration` for products that own their own migration list.
